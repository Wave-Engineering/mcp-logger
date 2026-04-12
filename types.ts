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
  msg?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  info: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  warn: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  error: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
}
