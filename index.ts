/**
 * @wave-engineering/mcp-logger
 *
 * Structured JSON-line logger for MCP servers.
 * See: https://github.com/Wave-Engineering/claudecode-workflow/blob/main/docs/mcp-logging-standard.md
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { LOG_LEVELS, type LogLevel, type Logger } from "./types.ts";

export { LOG_LEVELS, type LogLevel, type LogEntry, type Logger } from "./types.ts";

function resolveLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && env in LOG_LEVELS) return env as LogLevel;
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

    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      server: serverName,
      level,
      event,
      ...fields,
    };
    if (msg !== undefined) line.msg = msg;

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
