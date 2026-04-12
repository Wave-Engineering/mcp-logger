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
