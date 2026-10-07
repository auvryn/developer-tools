import type { Transport } from '../transport.js';
import type { Page, RequestOptions } from '../types.js';

/** What every resource needs: the transport and the key's organization. */
export interface Context {
  readonly transport: Transport;
  /** The organization of the API key (resolved once from `GET /api/v1/me`). */
  organizationId(options?: RequestOptions): Promise<string>;
}

/** Common call options of a read. */
export function read(options: RequestOptions = {}) {
  return { retryable: true, signal: options.signal, requestId: options.requestId };
}

/** Common call options of a write; only creates with an `Idempotency-Key` are retried. */
export function write(options: RequestOptions & { readonly idempotencyKey?: string | undefined }) {
  return {
    retryable: options.idempotencyKey !== undefined,
    signal: options.signal,
    requestId: options.requestId,
    idempotencyKey: options.idempotencyKey,
  };
}

/** A query without `undefined` values (the API rejects unknown or empty parameters). */
export function query<T extends Record<string, unknown>>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Follows `nextCursor` from page to page, yielding every item. */
export async function* iteratePages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.data;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

/** A full, unpaginated list presented as a single page. */
export function singlePage<T>(data: readonly T[]): Page<T> {
  return { data, nextCursor: null };
}
