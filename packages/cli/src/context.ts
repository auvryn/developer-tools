import { Auvryn, AuvrynError, WaitTimeoutError } from '@auvryn/sdk';

/*
 * What every command needs: configuration (flags, then environment), the SDK
 * client (created only when a command calls the API), and output that keeps
 * stdout machine-readable. The CLI holds no Auvryn logic of its own.
 */

/** Exit codes (docs/cli/README.md). */
export const EXIT = {
  ok: 0,
  /** The API (or the network, or a timeout) failed. */
  error: 1,
  /** Bad usage or configuration: nothing was sent. */
  usage: 2,
  /** The awaited operation finished, but not successfully (failed, cancelled, invalid). */
  unsuccessful: 3,
} as const;

export interface Io {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  /** Tests only: a fetch for the SDK. */
  readonly fetch?: ((request: Request) => Promise<Response>) | undefined;
}

export interface GlobalOptions {
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly apiUrl?: string;
  readonly project?: string;
}

/** A usage or configuration problem (exit 2). */
export class UsageError extends Error {}

/** An awaited operation ended unsuccessfully (exit 3); the resource is still printed. */
export class UnsuccessfulOutcome extends Error {}

const SDK_USAGE_CODES = new Set([
  'API_KEY_REQUIRED',
  'API_KEY_INVALID_FORMAT',
  'INVALID_BASE_URL',
  'INVALID_ARGUMENT',
]);

export class Context {
  #client: Auvryn | undefined;

  constructor(
    readonly io: Io,
    readonly options: GlobalOptions,
  ) {}

  get json(): boolean {
    return this.options.json === true;
  }

  /** The SDK client. Fails with a usage error, before any request, without an API key. */
  client(): Auvryn {
    if (this.#client) {
      return this.#client;
    }
    const apiKey = this.io.env['AUVRYN_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new UsageError(
        'AUVRYN_API_KEY is not set. Create an API key in Workspace → Developer → API keys and export it.',
      );
    }
    const baseUrl = this.options.apiUrl ?? this.io.env['AUVRYN_API_URL'];
    this.#client = new Auvryn({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      userAgent: `auvryn-cli/${this.io.version}`,
      ...(this.io.fetch ? { fetch: this.io.fetch } : {}),
    });
    return this.#client;
  }

  /** The project: `--project`, then `AUVRYN_PROJECT_ID`. */
  projectId(): string {
    const projectId = this.options.project ?? this.io.env['AUVRYN_PROJECT_ID'];
    if (projectId === undefined || projectId.trim() === '') {
      throw new UsageError('No project: pass --project prj_… or set AUVRYN_PROJECT_ID.');
    }
    return projectId.trim();
  }

  /** Progress and notes for people: stderr, never with --quiet. */
  note(message: string): void {
    if (this.options.quiet !== true) {
      this.io.stderr.write(`${message}\n`);
    }
  }

  /** The command's result: JSON (only that) on stdout with --json, otherwise text. */
  print(value: unknown, human: () => string): void {
    if (this.json) {
      this.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    } else {
      this.io.stdout.write(`${human()}\n`);
    }
  }

  /** Reports an error and returns the exit code. */
  fail(error: unknown): number {
    const code = exitCodeOf(error);
    const report = errorReport(error);
    if (this.json) {
      this.io.stdout.write(`${JSON.stringify({ error: report }, null, 2)}\n`);
    } else {
      const lines = [`Error: ${report.message}`];
      if (report.code) {
        lines.push(`  Code: ${report.code}`);
      }
      // Workspace capability and limit refusals (ADR-0032): what to ask Auvryn for.
      const capability = report.details?.['capability'];
      if (typeof capability === 'string') {
        lines.push(`  Capability: ${capability}`);
      }
      const limit = report.details?.['limit'];
      if (typeof limit === 'string') {
        lines.push(`  Limit: ${limit}`);
      }
      if (report.status) {
        lines.push(`  Status: ${String(report.status)}`);
      }
      if (report.requestId) {
        lines.push(`  Request ID: ${report.requestId}`);
      }
      if (report.retryAfterSeconds) {
        lines.push(`  Retry after: ${String(report.retryAfterSeconds)} s`);
      }
      this.io.stderr.write(`${lines.join('\n')}\n`);
    }
    return code;
  }
}

function exitCodeOf(error: unknown): number {
  if (error instanceof UsageError) {
    return EXIT.usage;
  }
  if (error instanceof AuvrynError && SDK_USAGE_CODES.has(error.code)) {
    return EXIT.usage;
  }
  return EXIT.error;
}

interface ErrorReport {
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
}

function errorReport(error: unknown): ErrorReport {
  if (error instanceof UsageError) {
    return { message: error.message, code: 'USAGE' };
  }
  if (error instanceof WaitTimeoutError) {
    return { message: error.message, code: error.code };
  }
  if (error instanceof AuvrynError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
      ...('retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { message: 'Cancelled.', code: 'ABORTED' };
  }
  // Unexpected: a generic message (never a stack, which could hold request data).
  return { message: 'Unexpected error.', code: 'UNEXPECTED' };
}

/** `90s`, `10m`, `1h` or plain seconds → milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) {
    throw new UsageError(`Invalid duration "${value}": use e.g. 90s, 10m or 1h.`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const ms = amount * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit as 'ms' | 's' | 'm' | 'h'];
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(`Invalid duration "${value}": it must be positive.`);
  }
  return ms;
}

export function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new UsageError('--limit must be an integer from 1 to 100.');
  }
  return limit;
}
