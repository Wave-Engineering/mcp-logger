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
  /**
   * Names of caller fields dropped because their value could not be logged:
   * a function (JSON cannot carry one), or a getter that threw when read.
   * The sentinel `<enumeration-failed>` means the fields object itself could
   * not be enumerated, so no field name is knowable.
   *
   * Distinct from `reserved_conflict` deliberately: that one means "you named a
   * field the logger owns", this one means "the value could not be represented".
   * Different causes, different fixes for the caller.
   */
  dropped_fields?: string[];
  /**
   * Present and `true` when the fields object itself could not be enumerated —
   * a Proxy whose `ownKeys` trap threw. No field name is knowable in that case,
   * which is why this is a whole-line flag rather than an entry in
   * `dropped_fields`.
   */
  enumeration_failed?: boolean;
  /**
   * Present and `true` when the entry could not be serialised even after the
   * fallback pass. The envelope is still accurate; every caller-supplied field
   * is absent from the line.
   */
  serialization_error?: boolean;
  /**
   * Caller-supplied fields are copied to the top level.
   *
   * Two substituted values can appear here after a failed first serialisation
   * pass, and neither is a value the caller passed:
   *
   * - `"[circular or repeated reference]"` — the object graph could not be
   *   serialised directly. Named for what the detection can actually back: it
   *   flags any object seen more than once, so a value referenced twice
   *   WITHOUT a cycle is reported too. Do not read it as proof of a cycle.
   * - `"<n>n"` (e.g. `"42n"`) — a `BigInt`, which JSON cannot carry. Stringified
   *   with a trailing `n` rather than dropped, because the value is usually the
   *   thing being investigated.
   */
  [key: string]: unknown;
}

export interface Logger {
  debug: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  info: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  warn: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
  error: (event: string, fields?: Record<string, unknown>, msg?: string) => void;
}
