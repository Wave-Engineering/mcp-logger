import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../index.ts";

/** Capture stderr writes during a callback. */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
    if (typeof chunk === "string") lines.push(chunk.trimEnd());
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("createLogger", () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalLogFile = process.env.LOG_FILE;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FILE;
  });

  afterEach(() => {
    if (originalLogLevel !== undefined) process.env.LOG_LEVEL = originalLogLevel;
    else delete process.env.LOG_LEVEL;
    if (originalLogFile !== undefined) process.env.LOG_FILE = originalLogFile;
    else delete process.env.LOG_FILE;
  });

  test("returns Logger interface with all four methods", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  test("info writes JSON line to stderr", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("api_call", { method: "POST", status: 200 });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.server).toBe("disc");
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("api_call");
    expect(entry.method).toBe("POST");
    expect(entry.status).toBe(200);
  });

  test("debug suppressed at default info level", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.debug("detail", { key: "value" });
    });
    expect(lines).toHaveLength(0);
  });

  test("debug emitted at debug level", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.debug("detail", { key: "value" });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.level).toBe("debug");
  });

  test("error always emitted even at error level", () => {
    process.env.LOG_LEVEL = "error";
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("ignored", {});
      log.warn("ignored", {});
      log.error("crash", { code: 500 });
    });
    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0]).level).toBe("error");
  });

  test("fields spread into log entry at top level", () => {
    const log = createLogger("sdlc");
    const lines = captureStderr(() => {
      log.info("subprocess", { cmd: "gh", exit_code: 0, ms: 450 });
    });
    const entry = parseLine(lines[0]);
    expect(entry.cmd).toBe("gh");
    expect(entry.exit_code).toBe(0);
    expect(entry.ms).toBe(450);
    // Not nested
    expect(entry.fields).toBeUndefined();
  });

  test("msg field included when provided", () => {
    const log = createLogger("watcher");
    const lines = captureStderr(() => {
      log.warn("state_change", { what: "kill_switch", to: "engaged" }, "429 received");
    });
    const entry = parseLine(lines[0]);
    expect(entry.msg).toBe("429 received");
  });

  test("msg field absent when omitted", () => {
    const log = createLogger("watcher");
    const lines = captureStderr(() => {
      log.info("poll", { channels: 7, new_messages: 3 });
    });
    const entry = parseLine(lines[0]);
    expect("msg" in entry).toBe(false);
  });

  test("ts field is ISO 8601 with milliseconds", () => {
    const log = createLogger("nerf");
    const lines = captureStderr(() => {
      log.info("startup", {});
    });
    const entry = parseLine(lines[0]);
    const ts = entry.ts as string;
    // ISO 8601: 2026-04-12T18:32:01.123Z
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("server field matches constructor argument", () => {
    const log = createLogger("wtf");
    const lines = captureStderr(() => {
      log.info("test", {});
    });
    expect(parseLine(lines[0]).server).toBe("wtf");
  });

  test("LOG_FILE writes to file", () => {
    const logPath = join(tmpdir(), `mcp-logger-test-${Date.now()}.jsonl`);
    process.env.LOG_FILE = logPath;
    const log = createLogger("disc");
    // Suppress stderr during test
    captureStderr(() => {
      log.info("api_call", { method: "GET", status: 200 });
      log.warn("state_change", { what: "kill_switch" });
    });
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(content).toHaveLength(2);
    expect(parseLine(content[0]).event).toBe("api_call");
    expect(parseLine(content[1]).event).toBe("state_change");
    rmSync(logPath);
  });

  test("LOG_FILE creates parent directories", () => {
    const dir = join(tmpdir(), `mcp-logger-nested-${Date.now()}`, "deep");
    const logPath = join(dir, "test.jsonl");
    process.env.LOG_FILE = logPath;
    const log = createLogger("disc");
    captureStderr(() => {
      log.info("test", {});
    });
    expect(existsSync(logPath)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  test("LOG_FILE with tilde expansion resolves to homedir", () => {
    const logPath = join(tmpdir(), `mcp-logger-tilde-${Date.now()}.jsonl`);
    // Construct a ~-relative path that resolves to the same place
    const relative = logPath.replace(homedir(), "~");
    // Only test if the path actually starts with homedir (tmpdir might not)
    if (logPath.startsWith(homedir())) {
      process.env.LOG_FILE = relative;
      const log = createLogger("disc");
      captureStderr(() => {
        log.info("test", {});
      });
      expect(existsSync(logPath)).toBe(true);
      rmSync(logPath);
    } else {
      // tmpdir is not under homedir — skip tilde test, just verify direct path works
      process.env.LOG_FILE = logPath;
      const log = createLogger("disc");
      captureStderr(() => {
        log.info("test", {});
      });
      expect(existsSync(logPath)).toBe(true);
      rmSync(logPath);
    }
  });

  test("invalid LOG_LEVEL falls back to info", () => {
    process.env.LOG_LEVEL = "banana";
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.debug("should_be_suppressed", {});
      log.info("should_appear", {});
    });
    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0]).event).toBe("should_appear");
  });
});

// --- #2: LOG_LEVEL validation must not walk the prototype chain -------------
//
// `banana` above is not on Object.prototype, so it exercises only the easy half
// of the guard. `constructor`/`toString`/`valueOf` ARE, and under `in` they pass
// validation, resolve to a function, and turn the numeric threshold check into a
// NaN comparison that is always false — every level emits, filtering disabled.

/**
 * Save and restore LOG_LEVEL/LOG_FILE around each test in a block.
 *
 * Every block that mutates them must call this. A block that only deletes in
 * `beforeEach` leaves the env wiped for whatever runs next — harmless while it
 * happens to run last, which is precisely why it would go unnoticed until a new
 * block is appended after it.
 */
function isolateLogEnv(): void {
  const original = { level: process.env.LOG_LEVEL, file: process.env.LOG_FILE };

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FILE;
  });

  afterEach(() => {
    if (original.level !== undefined) process.env.LOG_LEVEL = original.level;
    else delete process.env.LOG_LEVEL;
    if (original.file !== undefined) process.env.LOG_FILE = original.file;
    else delete process.env.LOG_FILE;
  });
}

describe("LOG_LEVEL prototype-chain validation (#2)", () => {
  isolateLogEnv();

  function expectFallsBackToInfo(value: string): void {
    process.env.LOG_LEVEL = value;
    const log = createLogger("probe");
    const lines = captureStderr(() => {
      log.debug("must_be_filtered", {});
      log.info("positive_control", {});
    });
    // The positive control is load-bearing. Asserting only that the debug line
    // is absent would pass identically if the logger emitted NOTHING —
    // "filtered correctly" and "silently broken" would be indistinguishable.
    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0]).event).toBe("positive_control");
  }

  // These two are the ONLY Object.prototype members reachable here, and the
  // reason is worth stating: resolveLevel() lowercases the env value first, and
  // every other prototype member has a capital letter. Verified empirically
  // against the unfixed implementation — both leak, everything else does not.
  for (const proto of ["constructor", "__proto__"]) {
    test(`LOG_LEVEL=${proto} falls back to info rather than disabling the filter`, () => {
      expectFallsBackToInfo(proto);
    });
  }

  // Stated plainly because it matters when reading these as evidence: the three
  // below PASSED before the fix. They are NOT evidence for this bug. They exist
  // because the lowercasing that neutralises them today is incidental — a
  // refactor supporting case-sensitive levels would silently make all three
  // reachable, and nothing else would notice.
  for (const proto of ["toString", "valueOf", "hasOwnProperty"]) {
    test(`LOG_LEVEL=${proto} stays filtered if the lowercasing is ever dropped`, () => {
      expectFallsBackToInfo(proto);
    });
  }

  test("a genuinely valid LOG_LEVEL is still honoured", () => {
    // Regression guard, not bug evidence — this passed before the fix too. It
    // catches the opposite failure: a fix that rejects everything would satisfy
    // every test above while breaking level configuration entirely.
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("probe");
    const lines = captureStderr(() => {
      log.debug("debug_must_appear", {});
    });
    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0]).event).toBe("debug_must_appear");
  });
});

// --- #1: process attribution ------------------------------------------------

describe("process attribution (#1)", () => {
  isolateLogEnv();

  test("every level carries pid and instance", () => {
    // The property polyjuice's wrapper test protected: attribution must not be
    // present on some levels and missing from others.
    const log = createLogger("watcher");
    const lines = captureStderr(() => {
      log.error("e", {});
      log.warn("w", {});
      log.info("i", {});
    });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const entry = parseLine(line);
      expect(entry.pid).toBe(process.pid);
      expect(typeof entry.instance).toBe("string");
      expect((entry.instance as string).length).toBeGreaterThan(0);
    }
  });

  test("debug carries attribution too when the level permits it", () => {
    process.env.LOG_LEVEL = "debug";
    const log = createLogger("watcher");
    const lines = captureStderr(() => {
      log.debug("d", {});
    });
    expect(lines).toHaveLength(1);
    expect(parseLine(lines[0]).pid).toBe(process.pid);
    expect(typeof parseLine(lines[0]).instance).toBe("string");
  });

  test("instance is stable across separate loggers in one process", () => {
    // Load-bearing: mcp-server-wtf calls createLogger() in three modules. A
    // per-logger id would make one process read as three in a shared log.
    const a = createLogger("wtf");
    const b = createLogger("wtf");
    const lines = captureStderr(() => {
      a.info("from_a", {});
      b.info("from_b", {});
    });
    expect(lines).toHaveLength(2);
    const first = parseLine(lines[0]).instance;
    expect(typeof first).toBe("string");
    expect(parseLine(lines[1]).instance).toBe(first);
  });

  test("ts still leads the emitted line", () => {
    // Regression guard, not bug evidence — this passed before the fix too.
    // Reserved-wins precedence must not come at the cost of key order: a JSONL
    // file scanned by eye is far worse if arbitrary caller fields precede ts.
    // The obvious `{...fields, ts, ...}` implementation would break this.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { zebra: 1, apple: 2 });
    });
    expect(lines).toHaveLength(1);
    expect(Object.keys(parseLine(lines[0]))[0]).toBe("ts");
  });

  test("an integer-like caller key sorts ahead of ts — known limit, not a bug", () => {
    // Pinning the documented exception rather than leaving the stronger claim
    // untested and false. JS enumerates integer-like keys first regardless of
    // insertion order, so `ts` cannot be guaranteed first. Cosmetic only: the
    // assertions below confirm no envelope field is altered by it.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { "0": "first" });
    });
    expect(lines).toHaveLength(1);
    const keys = Object.keys(parseLine(lines[0]));
    expect(keys[0]).toBe("0");
    expect(keys).toContain("ts");

    const entry = parseLine(lines[0]);
    expect(entry.server).toBe("disc");
    expect(entry.level).toBe("info");
    expect(entry.pid).toBe(process.pid);
  });
});

// --- #1: reserved-field precedence ------------------------------------------

describe("reserved field precedence (#1)", () => {
  isolateLogEnv();

  test("caller fields cannot overwrite the envelope", () => {
    // The defect this closes: an error emitted as level:"debug" is dropped by
    // any downstream level filter — silent misclassification of the exact
    // signal an incident investigation depends on.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.error("real_event", {
        ts: "1999",
        server: "spoofed",
        level: "debug",
        event: "hijacked",
      });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.server).toBe("disc");
    expect(entry.level).toBe("error");
    expect(entry.event).toBe("real_event");
    expect(entry.ts).not.toBe("1999");
  });

  test("caller fields cannot overwrite attribution", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { pid: 999999, instance: "forged" });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.pid).toBe(process.pid);
    expect(entry.instance).not.toBe("forged");
  });

  test("dropped field names are recorded rather than silently discarded", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { pid: 1, level: "debug", kept: "yes" });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.reserved_conflict).toEqual(expect.arrayContaining(["pid", "level"]));
    expect(entry.kept).toBe("yes");
  });

  test("no conflict marker when nothing collided", () => {
    // Regression guard, not bug evidence — passes pre-fix (the field did not
    // exist then). It pins that the marker stays absent in the common case,
    // so its presence in a log line always means something actually collided.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { method: "POST", status: 200 });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.reserved_conflict).toBeUndefined();
    expect(entry.method).toBe("POST");
  });

  test("a caller cannot forge the conflict record itself", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { reserved_conflict: ["nothing_wrong_here"] });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.reserved_conflict).toEqual(["reserved_conflict"]);
  });

  test("a __proto__ caller field survives instead of vanishing silently", () => {
    // JSON.parse produces an OWN `__proto__` key, and these servers log parsed
    // API payloads directly — so this is reachable from any Discord response.
    // Plain `line[key] = value` would invoke the inherited prototype setter:
    // the field disappears from the output with no conflict recorded, and the
    // entry's prototype is swapped for caller data.
    const log = createLogger("disc");
    const payload = JSON.parse(String.raw`{"__proto__":{"injected":true},"kept":1}`);
    expect(Object.keys(payload)).toContain("__proto__"); // input non-empty
    const lines = captureStderr(() => {
      log.info("payload", payload);
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.kept).toBe(1);
    expect(entry.__proto__).toEqual({ injected: true });
    // Envelope integrity is unaffected either way — assert it explicitly so a
    // future change to this path cannot quietly open a forgery route.
    expect(entry.server).toBe("disc");
    expect(entry.pid).toBe(process.pid);
  });

  test("a function value on a normal key is dropped AND recorded", () => {
    // Pre-existing silent loss: JSON.stringify discards function-valued
    // properties with no error and no trace. The value still cannot be logged
    // — JSON has no way to carry it — but the caller now learns that it wasn't.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { callback: () => 1, kept: "yes" });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.kept).toBe("yes");
    expect(entry.callback).toBeUndefined();
    expect(entry.dropped_fields).toEqual(["callback"]);
  });

  test("a reserved name wins over the unserialisable-value diagnosis", () => {
    // `toJSON: fn` is both a reserved-name collision and an unloggable value.
    // The name collision is reported because renaming is the fix; telling the
    // caller to change the value would not help them.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { toJSON: () => ({ forged: true }) });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.reserved_conflict).toEqual(["toJSON"]);
    expect(entry.dropped_fields).toBeUndefined();
  });

  test("a caller-supplied toJSON cannot forge the entire envelope", () => {
    // The blocker. Installed as an own property, JSON.stringify CALLS it and
    // serializes the return — every envelope field caller-chosen, ts included,
    // with no conflict marker and nothing marking the line as inauthentic.
    // Pre-existing (the previous spread produced a byte-identical forgery), but
    // this change is what states "reserved keys cannot be overwritten" as a
    // documented property, and that sentence must not outrun the mechanism.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("real_event", {
        toJSON: () => ({
          ts: "1999-01-01T00:00:00.000Z",
          server: "spoofed",
          level: "debug",
          event: "hijacked",
          pid: 999999,
          instance: "forged",
        }),
      });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.server).toBe("disc");
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("real_event");
    expect(entry.pid).toBe(process.pid);
    expect(entry.ts).not.toBe("1999-01-01T00:00:00.000Z");
    expect(entry.reserved_conflict).toEqual(["toJSON"]);
  });

  test("toString and valueOf are reserved as the same class of hook", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { toString: () => "x", valueOf: () => 1, kept: "yes" });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.kept).toBe("yes");
    expect(entry.reserved_conflict).toEqual(
      expect.arrayContaining(["toString", "valueOf"]),
    );
  });

  test("an explicitly undefined reserved field records no phantom conflict", () => {
    // Symmetry with the msg path. `{pid: undefined}` discards nothing, so the
    // marker must stay silent — one contract behaving two ways across two paths
    // is how a guarantee quietly stops being true.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { pid: undefined, kept: 1 });
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.pid).toBe(process.pid);
    expect(entry.kept).toBe(1);
    expect(entry.reserved_conflict).toBeUndefined();
  });

  test("an explicitly undefined msg field records no phantom conflict", () => {
    // The marker's contract is "a value was discarded". `{msg: undefined}`
    // discards nothing, so firing here would erode the guarantee that makes
    // the marker worth reading at all.
    const log = createLogger("disc");
    const lines = captureStderr(() => {
      log.info("evt", { msg: undefined }, "real message");
    });
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.msg).toBe("real message");
    expect(entry.reserved_conflict).toBeUndefined();
  });

  test("a null or omitted fields argument does not crash the caller", () => {
    // Regression guard for this change specifically. The previous implementation
    // spread `{...fields}` and `{...null}` is legal JS, so null used to emit a
    // line. Object.entries(null) throws — which would take down the host process
    // from inside a logger. Wrappers reach this path through `as any` casts.
    const log = createLogger("watcher");
    const lines = captureStderr(() => {
      log.info("omitted");
      log.info("explicit_null", null as unknown as Record<string, unknown>);
    });
    expect(lines).toHaveLength(2);
    expect(parseLine(lines[0]).event).toBe("omitted");
    expect(parseLine(lines[1]).event).toBe("explicit_null");
    expect(parseLine(lines[1]).pid).toBe(process.pid);
  });

  test("a msg field collides only when the third argument is supplied", () => {
    // A live consumer calls log.error("forward", { to, msg: msg.id }, String(err)) —
    // the message id was being discarded by the third argument with no trace.
    const log = createLogger("watcher");
    const lines = captureStderr(() => {
      log.error("forward", { to: "x", msg: "message-id-123" }, "boom");
      log.info("forward", { to: "x", msg: "message-id-456" });
    });
    expect(lines).toHaveLength(2);

    const clobbered = parseLine(lines[0]);
    expect(clobbered.msg).toBe("boom");
    expect(clobbered.reserved_conflict).toEqual(["msg"]);

    const passthrough = parseLine(lines[1]);
    expect(passthrough.msg).toBe("message-id-456");
    expect(passthrough.reserved_conflict).toBeUndefined();
  });
});

// --- #3: the logger must never take down its host ----------------------------
//
// `Object.keys`, property reads, and `JSON.stringify` all sit on the path an
// ordinary log call takes, and all three can throw on ordinary server values.
// Before this, only the file append was guarded — so a request object with a
// back-reference, or an id that arrived as a BigInt, would propagate out of
// emit() and into whatever the server was doing.
//
// Every test here pairs "did not throw" with a positive control asserting a
// line was actually emitted. Without that pairing, a logger that silently
// swallowed the call would pass every one of them.

describe("never crashes the host (#3)", () => {
  isolateLogEnv();

  test("a circular reference is represented, not thrown", () => {
    const log = createLogger("disc");
    const req: Record<string, unknown> = { name: "req" };
    req.self = req;
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() => log.info("circ", req));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.name).toBe("req");
    expect(entry.event).toBe("circ");
    // Named for what the detection can back: it flags any object seen twice,
    // cycle or not, so claiming "[Circular]" would send a reader hunting a
    // cycle that may not exist.
    expect(JSON.stringify(entry)).toContain("[circular or repeated reference]");
  });

  test("a BigInt is represented, not thrown", () => {
    const log = createLogger("disc");
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() => log.info("big", { id: BigInt("9007199254740993") }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    // Stringified rather than dropped: the value is the thing an investigation
    // wants, and JSON has no bigint to carry it in.
    expect(parseLine(lines[0]).id).toBe("9007199254740993n");
  });

  test("a throwing getter costs one field, not the line", () => {
    const log = createLogger("disc");
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() =>
        log.info("getter", {
          get boom() {
            throw new Error("getter exploded");
          },
          kept: "yes",
        }),
      );
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    // The surviving field is the point: losing the whole event because one
    // field misbehaved would discard the report of the thing going wrong.
    expect(entry.kept).toBe("yes");
    expect(entry.dropped_fields).toEqual(["boom"]);
  });

  test("a hostile Proxy cannot crash the logger", () => {
    const log = createLogger("disc");
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys exploded");
        },
      },
    );
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() => log.warn("proxy", hostile));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.event).toBe("proxy");
    // A whole-line flag, not a field name. A sentinel string inside
    // `dropped_fields` would be forgeable by a caller field of that name, and
    // would conflate "this named field was dropped" with "no name is knowable".
    expect(entry.enumeration_failed).toBe(true);
    expect(entry.dropped_fields).toBeUndefined();
  });

  test("a throwing toJSON on a nested value degrades to the envelope", () => {
    // The replacer cannot save this: JSON.stringify calls a nested toJSON
    // before the replacer ever sees the value. The line degrades to the
    // envelope rather than being lost — a dropped line is its own defect.
    const log = createLogger("disc");
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() =>
        log.error("nested", {
          payload: {
            toJSON() {
              throw new Error("nested toJSON exploded");
            },
          },
        }),
      );
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.serialization_error).toBe(true);
    // The envelope must survive every degraded path, or a fallback line becomes
    // a second forgery route.
    expect(entry.server).toBe("disc");
    expect(entry.level).toBe("error");
    expect(entry.event).toBe("nested");
    expect(entry.pid).toBe(process.pid);
    expect(typeof entry.instance).toBe("string");
  });

  test("the envelope is intact on every degraded path", () => {
    const log = createLogger("watcher");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const cases: Array<Record<string, unknown>> = [
      circular,
      { id: BigInt(1) },
      {
        get boom() {
          throw new Error("x");
        },
      },
      { fn: () => 1 },
    ];
    const lines = captureStderr(() => {
      for (const c of cases) log.error("degraded", c);
    });
    expect(lines).toHaveLength(cases.length);
    for (const line of lines) {
      const entry = parseLine(line);
      expect(entry.server).toBe("watcher");
      expect(entry.level).toBe("error");
      expect(entry.event).toBe("degraded");
      expect(entry.pid).toBe(process.pid);
    }
  });

  test("a hostile serverName costs one label, not every field", () => {
    // Found by tracing the fallback rather than by a test failing: `server` and
    // `event` are typed string but reach this package through `as any` casts,
    // and an object with a throwing toJSON in either one defeated ALL THREE
    // serialisation attempts — including the fallback, which read them.
    //
    // Sanitising at the boundary is what keeps this cheap: the line still
    // carries the caller's fields. Fixing it only in the fallback would have
    // degraded every line the logger ever emitted, forever.
    const hostile = {
      toJSON() {
        throw new Error("server name exploded");
      },
    };
    const log = createLogger(hostile as unknown as string);
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() => log.info("evt", { a: 1 }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.server).toBe("<invalid-server:object>");
    // The load-bearing assertion: caller data survives a bad label.
    expect(entry.a).toBe(1);
    expect(entry.serialization_error).toBeUndefined();
  });

  test("a hostile event name does not crash the caller", () => {
    const hostile = {
      toJSON() {
        throw new Error("event exploded");
      },
    };
    const log = createLogger("disc");
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() => log.info(hostile as unknown as string, { a: 1 }));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.event).toBe("<invalid-event:object>");
    expect(entry.server).toBe("disc");
  });

  test("a hostile label AND unserialisable fields still emit an envelope", () => {
    // Both hazards at once — the case that defeated the original fallback.
    const hostile = {
      toJSON() {
        throw new Error("boom");
      },
    };
    const log = createLogger(hostile as unknown as string);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let lines: string[] = [];
    expect(() => {
      lines = captureStderr(() => log.error("evt", circular));
    }).not.toThrow();
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.level).toBe("error");
    expect(entry.pid).toBe(process.pid);
    expect(typeof entry.instance).toBe("string");
    expect(entry.server).toBe("<invalid-server:object>");
  });

  test("a broken stderr does not propagate AND the file sink still receives the line", () => {
    // stderr is the primary sink and was the last unguarded write. A closed or
    // full pipe throws EPIPE/ENOSPC, and the contract this package states about
    // itself does not exempt its own primary channel.
    //
    // The file assertion is the point, not decoration. `not.toThrow()` alone
    // would pass for an emit() that returned early and wrote nothing — and the
    // live scenario is an MCP server whose stdio peer went away while the
    // durable log is precisely what you still need. Because stderr is written
    // BEFORE the file append, an unguarded throw there skips the file sink
    // entirely: exactly the record you would go looking for afterwards.
    const logPath = join(tmpdir(), `mcp-logger-epipe-${Date.now()}.jsonl`);
    process.env.LOG_FILE = logPath;
    const log = createLogger("disc");

    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => {
      throw new Error("EPIPE");
    };
    try {
      expect(() => log.info("evt", { a: 1 })).not.toThrow();
    } finally {
      process.stderr.write = original;
    }

    expect(existsSync(logPath)).toBe(true);
    const entry = parseLine(readFileSync(logPath, "utf-8").trim());
    expect(entry.event).toBe("evt");
    expect(entry.a).toBe(1);
    expect(entry.pid).toBe(process.pid);
    rmSync(logPath);
  });
});

// --- #3 follow-ups from review: the msg path must not be a second implementation
describe("msg is read exactly once (#3)", () => {
  isolateLogEnv();

  test("a msg getter's side effects run once, not twice", () => {
    // The second read was a bolt-on outside the loop that already had a rule
    // for reserved names. It invoked every `msg` accessor a second time.
    let reads = 0;
    const log = createLogger("disc");
    captureStderr(() =>
      log.info(
        "evt",
        {
          get msg() {
            reads++;
            return "caller-msg";
          },
        },
        "param-msg",
      ),
    );
    expect(reads).toBe(1);
  });

  test("a throwing msg getter records one marker, not two", () => {
    const log = createLogger("disc");
    const lines = captureStderr(() =>
      log.info(
        "evt",
        {
          get msg() {
            throw new Error("boom");
          },
        },
        "param-msg",
      ),
    );
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.msg).toBe("param-msg");
    expect(entry.dropped_fields).toEqual(["msg"]);
  });

  test("a function-valued msg reports the name collision alone", () => {
    // Previously emitted BOTH reserved_conflict and dropped_fields for one
    // field — contradicting the reserved-wins rule the copy loop documents.
    const log = createLogger("disc");
    const lines = captureStderr(() => log.info("evt", { msg: () => 1 }, "param-msg"));
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.msg).toBe("param-msg");
    expect(entry.reserved_conflict).toEqual(["msg"]);
    expect(entry.dropped_fields).toBeUndefined();
  });

  test("a msg field still passes through when no third argument is given", () => {
    // Regression guard: `msg` is reserved CONDITIONALLY. Making it
    // unconditionally reserved would silently drop a legitimate field.
    const log = createLogger("disc");
    const lines = captureStderr(() => log.info("evt", { msg: "caller-msg" }));
    expect(lines).toHaveLength(1);
    const entry = parseLine(lines[0]);
    expect(entry.msg).toBe("caller-msg");
    expect(entry.reserved_conflict).toBeUndefined();
  });
});
