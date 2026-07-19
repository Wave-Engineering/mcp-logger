/**
 * types.ts — Type definitions for @wave-engineering/mcp-logger
 */

export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;

export interface LogEntry {
  ts: string;
  server: string;
  level: LogLevel;
  event: string;
  /** OS process id of the emitting process. Logger-owned; not caller-settable. */
  pid: number;
  /**
   * Per-process token that disambiguates recycled pids. Logger-owned; stable
   * for the life of the process and shared by every logger it creates.
   */
  instance: string;
  /**
   * Human-readable message.
   *
   * Guaranteed to be a `string` only when the logger set it from the third
   * argument of a level method. A caller field named `msg` passes through
   * unvalidated when no third argument is supplied, so code reading this off a
   * parsed line should not assume the declared type holds.
   */
  msg?: string;
  /**
   * Names of caller fields dropped for colliding with a reserved key. Absent
   * when there was no collision — its presence means a caller tried to write a
   * field the logger owns, and the value was discarded.
   */
  reserved_conflict?: string[];
  [key: string]: unknown;
}

export interface Logger {
  debug: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  info: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  warn: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  error: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
}
