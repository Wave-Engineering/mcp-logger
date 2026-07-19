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
]);

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
      server: serverName,
      level,
      event,
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
    // Object.entries, not for...in: own enumerable properties only. `for...in`
    // would walk the prototype chain — the same defect class as `in` above.
    for (const [key, value] of Object.entries(safeFields)) {
      if (RESERVED.has(key)) {
        // Record only when a value was actually discarded. `{pid: undefined}`
        // loses nothing, and a marker that fires when nothing was lost erodes
        // the one guarantee that makes it worth reading. This is the same
        // `!== undefined` reasoning the msg path applies below — kept
        // symmetrical deliberately, since two paths with one contract and
        // opposite behaviour is how the guarantee quietly stops being true.
        if (value !== undefined) (conflicts ??= []).push(key);
        continue;
      }
      // defineProperty, NOT `line[key] = value`. For key `__proto__`, plain
      // assignment invokes the inherited Object.prototype setter instead of
      // creating an own property: the field vanishes from the output entirely
      // AND the entry's prototype is replaced with caller data — a silent drop
      // with no `reserved_conflict` entry, which is exactly what that marker
      // exists to prevent. Not theoretical: JSON.parse produces an own
      // `__proto__` key, and these servers log parsed API payloads directly.
      // The `{...fields}` spread this replaced defined own properties, so this
      // restores the previous behaviour rather than inventing new strictness.
      Object.defineProperty(line, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    if (msg !== undefined) {
      // `msg` is reserved only when the third argument is supplied; a caller
      // field named `msg` is otherwise legitimate and passes through untouched.
      // Recording the collision matters: a live consumer calls
      // `log.error("forward", { to, msg: msg.id }, String(err))`, where the
      // message id was being silently discarded by the third argument.
      //
      // `!== undefined` rather than hasOwn: an explicit `{ msg: undefined }`
      // discards no value, and a conflict marker that fires when nothing was
      // lost erodes the one guarantee that makes the marker worth reading.
      if (safeFields.msg !== undefined) (conflicts ??= []).push("msg");
      line.msg = msg;
    }

    if (conflicts) line.reserved_conflict = conflicts;

    const json = JSON.stringify(line);
    process.stderr.write(json + "\n");

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
