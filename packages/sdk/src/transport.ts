import createClient, { type Client } from 'openapi-fetch';

import { type AuvrynError, ConnectionError, apiErrorFromResponse } from './errors.js';
import type { paths } from './generated/openapi.js';

/*
 * The low-level transport: the generated OpenAPI types drive `openapi-fetch`
 * (path, parameter, body and response typing); this module adds what every
 * call needs — credentials, User-Agent, per-request timeout, error classes and
 * a small, safe retry policy. Nothing here knows about Auvryn resources.
 */

export type ApiClient = Client<paths>;

/** Status codes worth retrying when the request is safe to repeat. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
/** Delays before the 1st and 2nd retry. Never applied to 429 (see `RateLimitError`). */
const RETRY_DELAYS_MS = [300, 1_000] as const;

export interface TransportOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly fetch?: ((request: Request) => Promise<Response>) | undefined;
}

export interface CallOptions {
  /** Repeat on connection errors and 502/503/504 (GETs, and creates with an `Idempotency-Key`). */
  readonly retryable: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly requestId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Disable the per-request timeout (streamed downloads). */
  readonly noTimeout?: boolean;
}

/** What each attempt passes to the typed `openapi-fetch` call. */
export interface AttemptInit {
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal | null;
}

interface FetchResult {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Transport {
  readonly client: ApiClient;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly #timeoutMs: number;

  constructor(options: TransportOptions) {
    const { apiKey } = options;
    const send = options.fetch ?? ((request: Request) => globalThis.fetch(request));
    this.baseUrl = options.baseUrl;
    this.userAgent = options.userAgent;
    this.#timeoutMs = options.timeoutMs;
    this.client = createClient<paths>({
      baseUrl: options.baseUrl,
      // The key lives only in this closure: never on an enumerable property, in errors or logs.
      fetch: async (request) => {
        request.headers.set('Authorization', `Bearer ${apiKey}`);
        request.headers.set('User-Agent', options.userAgent);
        request.headers.set('Accept', request.headers.get('Accept') ?? 'application/json');
        try {
          return await send(request);
        } catch (error) {
          throw toConnectionError(error, request.signal, options.baseUrl);
        }
      },
    });
  }

  /**
   * Runs one typed API call and returns its data, or throws the matching
   * `AuvrynError`. Retries only when `retryable` (at most twice, short delays).
   */
  async call<R extends FetchResult>(
    attempt: (init: AttemptInit) => Promise<R>,
    options: CallOptions,
  ): Promise<NonNullable<R['data']>> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options.requestId !== undefined) {
      headers['X-Request-Id'] = options.requestId;
    }
    for (let retry = 0; ; retry += 1) {
      const signal = options.noTimeout
        ? options.signal
        : AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            AbortSignal.timeout(this.#timeoutMs),
          ]);
      let failure: AuvrynError;
      try {
        const result = await attempt({ headers, signal: signal ?? null });
        if (result.response.ok) {
          return result.data as NonNullable<R['data']>;
        }
        failure = apiErrorFromResponse(
          result.response.status,
          result.error,
          result.response.headers,
        );
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason;
        }
        if (!(error instanceof ConnectionError)) {
          throw error;
        }
        failure = error;
      }
      const transient =
        failure instanceof ConnectionError ||
        (failure.status !== undefined && RETRYABLE_STATUSES.has(failure.status));
      const wait = RETRY_DELAYS_MS[retry];
      if (!options.retryable || !transient || wait === undefined) {
        throw failure;
      }
      await delay(wait, options.signal);
    }
  }
}

/** Network failures and timeouts, without the URL's query, headers or credentials. */
function toConnectionError(error: unknown, signal: AbortSignal | null, baseUrl: string): unknown {
  const reason: unknown = signal?.aborted ? signal.reason : error;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return new ConnectionError({
      code: 'REQUEST_TIMEOUT',
      message: `The Auvryn API at ${new URL(baseUrl).origin} did not answer in time.`,
    });
  }
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return reason;
  }
  return new ConnectionError({
    code: 'CONNECTION_FAILED',
    message: `Could not reach the Auvryn API at ${new URL(baseUrl).origin}.`,
  });
}
