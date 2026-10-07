import { AuvrynError, WaitTimeoutError } from './errors.js';
import { delay } from './transport.js';

/*
 * The one polling primitive behind every `wait…` helper: read, stop when the
 * state is final, otherwise sleep. Always bounded by a finite timeout and
 * cancellable with an AbortSignal. Not a workflow engine: it never acts.
 */

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly signal?: AbortSignal | undefined;
  /** What is awaited, for the timeout message (e.g. "Execution job job_…"). */
  readonly description: string;
}

/** Smallest polling interval (protects the API and the caller's rate limit). */
export const MIN_POLL_INTERVAL_MS = 250;

export function checkWaitOptions(timeoutMs: number, intervalMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AuvrynError({
      code: 'INVALID_ARGUMENT',
      message: 'timeoutMs must be a finite, positive number of milliseconds.',
    });
  }
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_POLL_INTERVAL_MS) {
    throw new AuvrynError({
      code: 'INVALID_ARGUMENT',
      message: `intervalMs must be at least ${String(MIN_POLL_INTERVAL_MS)} milliseconds.`,
    });
  }
}

/** Reads until `isDone`; throws `WaitTimeoutError` (with the last state) at the deadline. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: PollOptions,
): Promise<T> {
  checkWaitOptions(options.timeoutMs, options.intervalMs);
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    const value = await read();
    if (isDone(value)) {
      return value;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WaitTimeoutError(
        `${options.description} did not finish within ${String(Math.round(options.timeoutMs / 1000))} s.`,
        value,
      );
    }
    await delay(Math.min(options.intervalMs, remaining), options.signal);
  }
}
