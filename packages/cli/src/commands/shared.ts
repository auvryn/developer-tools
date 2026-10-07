import type { Page } from '@auvryn/sdk';
import type { Command } from 'commander';

import { UsageError, parseDuration, parseLimit } from '../context.js';

/** `--limit`, `--cursor` and `--all` of list commands. */
export function withPaging(command: Command): Command {
  return command
    .option('--limit <n>', 'Items per page, 1-100 (default 100)')
    .option('--cursor <cursor>', 'Continue from a previous page (its nextCursor)')
    .option('--all', 'Fetch every page');
}

/** One page, or every page with `--all`. */
export async function readPage<T>(
  options: Record<string, unknown>,
  list: (paging: { limit?: number; cursor?: string }) => Promise<Page<T>>,
  iterate: (paging: { limit?: number }) => AsyncIterable<T>,
): Promise<Page<T>> {
  const limit = typeof options['limit'] === 'string' ? parseLimit(options['limit']) : undefined;
  const cursor = typeof options['cursor'] === 'string' ? options['cursor'] : undefined;
  if (options['all'] === true) {
    if (cursor !== undefined) {
      throw new UsageError('--all and --cursor cannot be combined.');
    }
    const data: T[] = [];
    for await (const item of iterate(limit === undefined ? {} : { limit })) {
      data.push(item);
    }
    return { data, nextCursor: null };
  }
  return list({
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
}

/** `--wait` and `--timeout` of commands that can wait. */
export function withWait(command: Command, defaultTimeout: string): Command {
  return command
    .option('--wait', 'Wait until it finishes (exit 3 if it does not succeed)')
    .option('--timeout <duration>', `Maximum wait, e.g. 90s, 10m, 1h (default ${defaultTimeout})`);
}

export function timeoutOf(options: Record<string, unknown>, fallback: string): number {
  return parseDuration(typeof options['timeout'] === 'string' ? options['timeout'] : fallback);
}

export function idempotency(command: Command): Command {
  return command.option(
    '--idempotency-key <key>',
    'Make retries safe: the same key and request return the same resource (24 h)',
  );
}

export function idempotencyKeyOf(options: Record<string, unknown>): { idempotencyKey?: string } {
  return typeof options['idempotencyKey'] === 'string'
    ? { idempotencyKey: options['idempotencyKey'] }
    : {};
}
