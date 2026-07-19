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
