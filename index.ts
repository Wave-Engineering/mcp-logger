/**
 * @wave-engineering/mcp-logger
 *
 * Structured JSON-line logger for MCP servers.
 * See: https://github.com/Wave-Engineering/claudecode-workflow/blob/main/docs/mcp-logging-standard.md
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { LOG_LEVELS, type LogEntry, type LogLevel, type Logger } from "./types.ts";

export { LOG_LEVELS, type LogLevel, type LogEntry, type Logger } from "./types.ts";

/**
 * Per-process instance id, emitted alongside `pid` on every line.
 *
 * A pid alone is not sufficient identity over a long-lived log: pids recycle, so
 * a restarted process can reuse a dead one's pid and become indistinguishable
 * from it hours apart in the same file.
 *
 * Module scope, NOT per-logger, and that is load-bearing: a process calling
 * `createLogger()` more than once (mcp-server-wtf does, in three modules) must
 * emit ONE instance id, or a single process reads as several.
 *
 * The format is inherited deliberately from the per-repo wrapper this replaces,
 * so lines emitted before and after the upgrade stay comparable while an
 * investigation is open.
 */
const LOG_INSTANCE_ID = `${process.pid.toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

/**
 * Envelope keys the logger owns. A caller field of the same name is dropped and
 * its name recorded in `reserved_conflict`, so the collision is visible in the
 * line rather than silent. `reserved_conflict` is itself reserved, so a caller
 * cannot forge the record of its own collision.
 *
 * WHAT THIS DOES NOT COVER — read before trusting `pid` for anything:
 * these fields describe the process that EMITTED the line, and nothing else.
 * A supervisor that legitimately needs to log about a *different* process (a
 * child it spawned) cannot put that pid in `pid`; it will be dropped. Use a
 * distinct key such as `child_pid`. The guarantee is deliberately narrow: this
 * envelope cannot express another process's identity in these fields, which is
 * exactly what makes `pid` trustworthy for attribution.
 *
 * `msg` is NOT listed here — it is reserved only when the third argument is
 * supplied. See `emit()`.
 */
const RESERVED = new Set<string>([
  "ts",
  "server",
  "level",
  "event",
  "pid",
  "instance",
  "reserved_conflict",
  // Serialization hooks, not envelope fields. `toJSON` is a TOTAL forgery route
  // and the reason this list exists at all: installed as an own property of the
  // entry, JSON.stringify CALLS it and serializes whatever it returns, so every
  // envelope field becomes caller-chosen — ts included — with no conflict marker
  // and nothing to distinguish the line from a genuine one.
  //
  // The route requires a CALLABLE value; a non-function `toJSON` is inert and
  // serializes as ordinary data (verified). `toString`/`valueOf` are the same
  // class of coercion hook and cost nothing to reserve, so they are listed
  // rather than argued about.
  //
  // LIMIT, because this is a denylist and denylists are promises: it closes the
  // names below, not the class. The general fix — refusing any value JSON cannot
  // serialize — is tracked in #3 along with the other JSON.stringify hazards,
  // because that same call can also throw and take the host process down.
  "toJSON",
  "toString",
  "valueOf",
  // Diagnostic markers the logger owns. Reserved so a caller cannot forge a
  // clean-looking line, for the same reason `reserved_conflict` is.
  "dropped_fields",
  "serialization_error",
  "enumeration_failed",
]);

/**
 * Envelope labels (`server`, `event`) are caller-supplied and typed `string`,
 * but consumers reach this package through `as any` casts, so the type is not a
 * guarantee. An object with a throwing `toJSON` passed as either one defeats
 * EVERY serialisation attempt below — including the fallback, which reads them.
 *
 * Coercing here rather than only in the fallback matters: a bad label would
 * otherwise degrade every line the logger ever emits, discarding all caller
 * fields forever. Sanitised at the boundary, one bad label costs one label.
 *
 * The `typeof` is reported in the marker so the caller can see what they passed
 * instead of just that it was rejected.
 */
function safeLabel(value: unknown, kind: string): string {
  return typeof value === "string" ? value : `<invalid-${kind}:${typeof value}>`;
}

/**
 * `JSON.stringify` that cannot throw.
 *
 * The fast path is tried first and succeeds for every well-formed line, so the
 * cost of the fallbacks is paid only by input that already failed. Ordinary
 * server values reach this: a request object with a back-reference, or an id
 * that arrived as a BigInt.
 *
 * Degrading is deliberate rather than swallowing. A logger that silently drops
 * the line it could not serialise trades a crash for a hole in the record,
 * which is worse during exactly the investigation the log exists for.
 */
function serialize(line: LogEntry): string {
  try {
    return JSON.stringify(line);
  } catch {
    try {
      // Represent what JSON cannot carry, rather than dying on it.
      //
      // IMPRECISION, and the sentinel is named for what it can actually back:
      // this marks every object on first visit, so a value referenced twice
      // without any cycle (`{a: x, b: x}`) is reported too. Correct detection
      // needs the ancestor chain rather than a seen-set, which is precision
      // nobody is paying for on a path that has already thrown once. Calling it
      // "[Circular]" would send a reader hunting a cycle that may not exist —
      // the log consumer reads the emitted line, never this comment.
      const seen = new WeakSet<object>();
      return JSON.stringify(line, (_key, value) => {
        if (typeof value === "bigint") return `${value}n`;
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[circular or repeated reference]";
          seen.add(value);
        }
        return value;
      });
    } catch {
      // Both attempts failed — a nested `toJSON` that throws defeats the
      // replacer too, since the replacer never sees a value whose toJSON threw.
      // Emit the envelope alone: a dropped line is its own defect, and the
      // envelope is the part an investigation needs most.
      //
      // This call is provably non-throwing, and the proof is the point. `ts`,
      // `level`, `pid` and `instance` are primitives this logger created.
      // `server` and `event` are caller-derived, so they are included ONLY when
      // they are genuinely strings — they are sanitised at the boundary by
      // safeLabel(), and this second check makes the floor self-contained
      // rather than dependent on that. An object of primitives cannot throw.
      const floor: Record<string, unknown> = {
        ts: line.ts,
        level: line.level,
        pid: line.pid,
        instance: line.instance,
        serialization_error: true,
      };
      if (typeof line.server === "string") floor.server = line.server;
      if (typeof line.event === "string") floor.event = line.event;
      return JSON.stringify(floor);
    }
  }
}

function resolveLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  // `Object.hasOwn`, not `in`: `in` walks Object.prototype, so LOG_LEVEL values
  // like `constructor` or `toString` would pass validation, resolve to a
  // function, and turn the numeric threshold check into a NaN comparison that
  // is always false — silently disabling level filtering altogether.
  if (env && Object.hasOwn(LOG_LEVELS, env)) return env as LogLevel;
  return "info";
}

function resolvePath(raw: string): string {
  return raw.replace(/^~/, homedir());
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Create a logger instance for an MCP server.
 *
 * @param serverName — short name baked into every log line (e.g., "disc", "watcher", "sdlc")
 */
export function createLogger(serverName: string): Logger {
  // Sanitised once, at construction, not per line — see safeLabel().
  const safeServerName = safeLabel(serverName, "server");

  const minLevel = resolveLevel();
  const logFile = process.env.LOG_FILE
    ? resolvePath(process.env.LOG_FILE)
    : null;

  let dirEnsured = false;

  function emit(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown>,
    msg?: string,
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

    // Attribution is built AFTER the threshold check, so a filtered-out line
    // costs nothing. A caller-side wrapper cannot do this without duplicating
    // the threshold logic in a second place.
    //
    // Reserved keys are written FIRST so `ts` leads the JSONL line for human
    // scanning, then caller fields are copied in with reserved names filtered
    // out. A plain `{...fields, ts, ...}` spread would also give reserved-wins
    // precedence, but would push `ts` behind arbitrary caller keys.
    //
    // LIMIT: this orders by insertion, and JavaScript does not. An integer-like
    // caller key (`{"0": ...}`) is enumerated before every string key regardless
    // of insertion order, so it lands ahead of `ts`. Cosmetic — no envelope
    // field is altered — but the property is "ts leads unless a caller field is
    // integer-like", not "ts leads", and stating the weaker true version beats
    // shipping the stronger false one.
    const line: LogEntry = {
      ts: new Date().toISOString(),
      server: safeServerName,
      level,
      event: safeLabel(event, "event"),
      pid: process.pid,
      instance: LOG_INSTANCE_ID,
    };

    // `?? {}` is load-bearing, not defensive noise. The previous implementation
    // spread `{...fields}`, and `{...null}` is legal JS — so a `null` reaching
    // here used to emit a line. Object.entries(null) THROWS, which would crash
    // the host process from inside a logger. Consumers reach this path through
    // `as any` casts (the Logger interface declares `fields` optional while
    // wrappers declare it required), so a null is reachable without a type error.
    const safeFields = fields ?? {};

    let conflicts: string[] | undefined;
    let dropped: string[] | undefined;
    let enumerationFailed = false;

    // `msg` is reserved ONLY when the third argument is supplied. Deciding that
    // once, here, lets the loop below apply it — rather than re-reading the
    // field afterwards, which read every `msg` getter a SECOND time (doubling
    // its side effects), could push a duplicate marker, and could emit both
    // `reserved_conflict` and `dropped_fields` for one field, contradicting the
    // reserved-wins rule this same loop documents ten lines down.
    const msgReserved = msg !== undefined;

    // Enumeration is guarded, not assumed. `Object.keys` on a hostile Proxy can
    // throw from its ownKeys trap, and reading a property can throw from a
    // getter. Both happen BEFORE any serialisation, and both previously escaped
    // emit() and took the host process down from inside a logging call.
    let keys: string[] = [];
    try {
      // Own enumerable properties only — `for...in` would walk the prototype
      // chain, the same defect class as `in` in resolveLevel above.
      keys = Object.keys(safeFields);
    } catch {
      // A whole-line diagnostic, not a field name — see `enumeration_failed`
      // in types.ts. Putting a sentinel string into a list of caller field
      // names would make it forgeable by a field of that name, and would
      // conflate "this named field was dropped" with "no name is knowable".
      enumerationFailed = true;
    }

    for (const key of keys) {
      let value: unknown;
      try {
        value = (safeFields as Record<string, unknown>)[key];
      } catch {
        // A throwing getter costs ONE field, not the whole line. Reading each
        // value in its own try is the difference between losing a field and
        // losing the event that was being reported when it happened.
        (dropped ??= []).push(key);
        continue;
      }

      if (RESERVED.has(key) || (msgReserved && key === "msg")) {
        // Record only when a value was actually discarded. `{pid: undefined}`
        // loses nothing, and a marker that fires when nothing was lost erodes
        // the one guarantee that makes it worth reading. This is the same
        // `!== undefined` reasoning the msg path applies below — kept
        // symmetrical deliberately, since two paths with one contract and
        // opposite behaviour is how the guarantee quietly stops being true.
        if (value !== undefined) (conflicts ??= []).push(key);
        continue;
      }

      // Checked AFTER the reserved test, deliberately. A field named `toJSON`
      // whose value is a function is BOTH a reserved-name collision and an
      // unserialisable value; reporting it as the name collision is the more
      // actionable of the two, because the fix is to rename it. Reversing this
      // order sends the caller to change the value instead, which will not help.
      //
      // For non-reserved names: JSON.stringify drops function-valued properties
      // silently — pre-existing behaviour, not a new restriction. Recording it
      // converts a silent loss into a visible one, and closes by VALUE the
      // general form of the hazard the RESERVED list can only close by NAME.
      if (typeof value === "function") {
        (dropped ??= []).push(key);
        continue;
      }

      // defineProperty, NOT `line[key] = value`. For key `__proto__`, plain
      // assignment invokes the inherited Object.prototype setter instead of
      // creating an own property: the field vanishes from the output entirely
      // AND the entry's prototype is replaced with caller data — a silent drop
      // with no `reserved_conflict` entry, which is exactly what that marker
      // exists to prevent. Reachable rather than theoretical: JSON.parse
      // produces an own `__proto__` key, so any caller logging a parsed payload
      // hits it. No consumer does today — all three hand-flatten to scalars,
      // verified across ~100 call sites — but that is a coding convention, not
      // an enforced property, and the first caller to log an object gets it.
      // The `{...fields}` spread this replaced defined own properties, so this
      // restores the previous behaviour rather than inventing new strictness.
      Object.defineProperty(line, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    // One read, one diagnosis. The loop above already recorded any conflict.
    if (msgReserved) line.msg = msg;

    if (conflicts) line.reserved_conflict = conflicts;
    if (dropped) line.dropped_fields = dropped;
    if (enumerationFailed) line.enumeration_failed = true;

    // serialize() cannot throw. A bare JSON.stringify here was the last
    // unguarded call in emit(): a circular reference or a BigInt anywhere in
    // the caller's fields would propagate out of the logger and into whatever
    // the server was doing.
    const json = serialize(line);

    // stderr can fail too — a closed or full pipe throws EPIPE/ENOSPC. Guarded
    // for the same reason the file sink is: the contract this file states about
    // itself is that logging never takes the process down, and stderr is not
    // exempt from that just because it is the primary sink.
    try {
      process.stderr.write(json + "\n");
    } catch {
      // Nothing to report it TO — stderr is the channel we would report on.
    }

    if (logFile) {
      try {
        if (!dirEnsured) {
          ensureDir(logFile);
          dirEnsured = true;
        }
        appendFileSync(logFile, json + "\n");
      } catch {
        // Best-effort — never crash the server over logging
      }
    }
  }

  return {
    debug: (event, fields = {}, msg?) => emit("debug", event, fields, msg),
    info: (event, fields = {}, msg?) => emit("info", event, fields, msg),
    warn: (event, fields = {}, msg?) => emit("warn", event, fields, msg),
    error: (event, fields = {}, msg?) => emit("error", event, fields, msg),
  };
}
