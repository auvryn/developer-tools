import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GENERATED_FILE, generateSdkTypes } from '../scripts/generate.mjs';
import {
  ApiError,
  AuthenticationError,
  Auvryn,
  AuvrynError,
  ConflictError,
  ConnectionError,
  DEFAULT_BASE_URL,
  EntitlementError,
  LimitReachedError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  SDK_VERSION,
  ValidationError,
} from '../src/index.js';
import {
  API_KEY,
  BASE_URL,
  JOBS_PATH,
  MODELS_PATH,
  ME,
  ORG,
  PROJECT,
  SECRET,
  apiError,
  fakeClient,
  json,
} from './support.js';

const model = (n: number) => ({
  id: `mdl_01j9qmt2hy7cgsr2yefxr86p${String(n).padStart(2, '0')}`,
  projectId: PROJECT,
  name: `Model ${String(n)}`,
  slug: `model-${String(n)}`,
  description: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
});

describe('configuration and secret handling', () => {
  it('requires a well-formed API key before any request, without echoing it', () => {
    expect(() => new Auvryn({ apiKey: '', baseUrl: BASE_URL })).toThrow(
      expect.objectContaining({ code: 'API_KEY_REQUIRED' }),
    );
    const malformed = `${API_KEY}x`;
    let error: unknown;
    try {
      new Auvryn({ apiKey: malformed, baseUrl: BASE_URL });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'API_KEY_INVALID_FORMAT' });
    expect(JSON.stringify(error) + String(error)).not.toContain(SECRET);
  });

  it('rejects base URLs with credentials, queries or other protocols', () => {
    for (const baseUrl of ['localhost:4000', 'ftp://x', 'http://u:p@x', 'http://x?a=1']) {
      expect(() => new Auvryn({ apiKey: API_KEY, baseUrl })).toThrow(
        expect.objectContaining({ code: 'INVALID_BASE_URL' }),
      );
    }
  });

  it('never reveals the key through inspect(), JSON or util.inspect', () => {
    const client = new Auvryn({ apiKey: API_KEY, baseUrl: `${BASE_URL}/` });
    expect(client.inspect()).toEqual({
      baseUrl: BASE_URL,
      apiVersion: 'v1',
      sdkVersion: SDK_VERSION,
      userAgent: `auvryn-js/${SDK_VERSION}`,
      apiKey: '[REDACTED]',
    });
    for (const text of [
      JSON.stringify(client),
      inspect(client, { depth: 10 }),
      String(Object.keys(client)),
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(API_KEY.slice(0, 30));
    }
  });

  it('declares SDK 0.x and API v1, matching its package', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_VERSION).toMatch(/^0\./);
  });
});

describe('requests', () => {
  it('sends the key as a bearer token, a User-Agent and paths under the base URL', async () => {
    const { client, requests } = fakeClient(() => json({ models: [], nextCursor: null }), {
      userAgent: 'my-pipeline/2.1',
    });
    await client.models.list({ projectId: PROJECT, requestId: 'req_mine' });
    const request = requests.at(-1);
    expect(request?.url).toBe(`${BASE_URL}${MODELS_PATH}`);
    expect(request?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(request?.headers.get('user-agent')).toBe(`my-pipeline/2.1 auvryn-js/${SDK_VERSION}`);
    expect(request?.headers.get('x-request-id')).toBe('req_mine');
  });

  it('resolves the key organization once, or not at all when given', async () => {
    const { client, calls } = fakeClient(() => json({ models: [], nextCursor: null }));
    await client.models.list({ projectId: PROJECT });
    await client.models.list({ projectId: PROJECT });
    expect(calls('/api/v1/me')).toHaveLength(1);
    const explicit = fakeClient(() => json({ models: [], nextCursor: null }), {
      organizationId: ORG,
    });
    await explicit.client.models.list({ projectId: PROJECT });
    expect(explicit.calls('/api/v1/me')).toHaveLength(0);
  });
});

describe('errors', () => {
  const cases = [
    [400, 'VALIDATION_FAILED', ValidationError],
    [401, 'INVALID_AUTHENTICATION', AuthenticationError],
    [403, 'INSUFFICIENT_SCOPE', PermissionError],
    [404, 'PROJECT_NOT_FOUND', NotFoundError],
    [409, 'MODEL_NOT_VALIDATED', ConflictError],
    [422, 'MODEL_ARTIFACT_VERIFICATION_FAILED', ValidationError],
    [500, 'INTERNAL_ERROR', ApiError],
  ] as const;

  it.each(cases)(
    'maps %i %s to a typed error with code, status, request ID and details',
    async (status, code, type) => {
      const { client } = fakeClient(() => apiError(status, code, {}, { field: 'name' }));
      const error = await client.models
        .list({ projectId: PROJECT })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(type);
      expect(error).toBeInstanceOf(AuvrynError);
      expect(error).toMatchObject({
        code,
        status,
        requestId: 'req_err',
        details: { field: 'name' },
      });
      expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(SECRET);
    },
  );

  it('tells role refusals, missing capabilities and reached limits apart (ADR-0032)', async () => {
    const errorFor = async (status: number, code: string) => {
      const { client } = fakeClient(() => apiError(status, code));
      return client.models.list({ projectId: PROJECT }).catch((caught: unknown) => caught);
    };
    const role = await errorFor(403, 'INSUFFICIENT_ROLE');
    expect(role).toBeInstanceOf(PermissionError);
    expect(role).not.toBeInstanceOf(EntitlementError);
    for (const code of ['ENTITLEMENT_REQUIRED', 'ENTITLEMENT_EXPIRED']) {
      const missing = await errorFor(403, code);
      // Still a PermissionError, so existing `instanceof` checks keep working.
      expect(missing).toBeInstanceOf(EntitlementError);
      expect(missing).toBeInstanceOf(PermissionError);
    }
    for (const code of [
      'WORKSPACE_LIMIT_REACHED',
      'CONCURRENT_RUN_LIMIT_REACHED',
      'SAMPLE_RUN_LIMIT_REACHED',
    ]) {
      const limit = await errorFor(409, code);
      expect(limit).toBeInstanceOf(LimitReachedError);
      expect(limit).toBeInstanceOf(ConflictError);
    }
    expect(await errorFor(409, 'MODEL_SLUG_CONFLICT')).not.toBeInstanceOf(LimitReachedError);
  });

  it('turns 429 into RateLimitError with Retry-After, and never retries or sleeps', async () => {
    const { client, calls } = fakeClient(() =>
      apiError(429, 'RATE_LIMITED', { 'retry-after': '17' }),
    );
    const error = await client.models
      .list({ projectId: PROJECT })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(17);
    expect(calls(MODELS_PATH)).toHaveLength(1);
  });

  it('reports a response without an error body as UNEXPECTED_RESPONSE', async () => {
    const { client } = fakeClient(() => new Response('<html>bad gateway</html>', { status: 418 }));
    await expect(client.models.list({ projectId: PROJECT })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      status: 418,
    });
  });

  it('wraps network failures and timeouts in ConnectionError without the key', async () => {
    const down = fakeClient(
      () => {
        throw new TypeError('fetch failed');
      },
      { organizationId: ORG },
    );
    const error = await down.client.models
      .list({ projectId: PROJECT })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(String(error)).not.toContain(SECRET);
    // GETs are retried twice.
    expect(down.calls(MODELS_PATH)).toHaveLength(3);

    const slow = fakeClient(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason as Error));
        }),
      { organizationId: ORG, timeoutMs: 50 },
    );
    await expect(
      slow.client.models.get({ projectId: PROJECT, modelId: 'mdl_x' }),
    ).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
  });
});

describe('retries and idempotency', () => {
  it('retries GETs on 502/503/504 only', async () => {
    let attempt = 0;
    const { client, calls } = fakeClient(() =>
      (attempt += 1) === 1 ? apiError(503, 'INTERNAL_ERROR') : json(model(1)),
    );
    await expect(
      client.models.get({ projectId: PROJECT, modelId: 'mdl_1' }),
    ).resolves.toMatchObject({
      name: 'Model 1',
    });
    expect(calls(`${MODELS_PATH}/mdl_1`)).toHaveLength(2);
  });

  it('never retries a create without an Idempotency-Key, and sends none', async () => {
    const { client, calls } = fakeClient(() => apiError(503, 'INTERNAL_ERROR'));
    await expect(
      client.executions.create({ projectId: PROJECT, costEstimateId: 'est_1' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls(JOBS_PATH)).toHaveLength(1);
    expect(calls(JOBS_PATH)[0]?.headers.has('idempotency-key')).toBe(false);
  });

  it('retries a create with an Idempotency-Key, sending the same key every time', async () => {
    let attempt = 0;
    const { client, calls } = fakeClient(() =>
      (attempt += 1) < 3
        ? apiError(502, 'INTERNAL_ERROR')
        : json({ id: 'job_1', status: 'created' }, 202),
    );
    const key = Auvryn.idempotencyKey();
    await expect(
      client.executions.create({
        projectId: PROJECT,
        costEstimateId: 'est_1',
        idempotencyKey: key,
      }),
    ).resolves.toMatchObject({ id: 'job_1' });
    expect(calls(JOBS_PATH).map((r) => r.headers.get('idempotency-key'))).toEqual([key, key, key]);
    expect(await calls(JOBS_PATH)[0]?.json()).toEqual({ costEstimateId: 'est_1' });
  });

  it('surfaces IDEMPOTENCY_CONFLICT as a ConflictError, without retrying', async () => {
    const { client, calls } = fakeClient(() => apiError(409, 'IDEMPOTENCY_CONFLICT'));
    await expect(
      client.executions.create({
        projectId: PROJECT,
        costEstimateId: 'est_2',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(calls(JOBS_PATH)).toHaveLength(1);
  });

  it('generates distinct idempotency keys', () => {
    const keys = new Set(Array.from({ length: 100 }, () => Auvryn.idempotencyKey()));
    expect(keys.size).toBe(100);
  });
});

describe('pagination', () => {
  it('returns { data, nextCursor } and passes limit and cursor', async () => {
    const { client, requests } = fakeClient(() => json({ models: [model(1)], nextCursor: 'abc' }));
    const page = await client.models.list({ projectId: PROJECT, limit: 1, cursor: 'xyz' });
    expect(page).toEqual({ data: [model(1)], nextCursor: 'abc' });
    const url = new URL(requests.at(-1)?.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '1', cursor: 'xyz' });
  });

  it('iterates every item across pages', async () => {
    const pages: Record<string, { models: unknown[]; nextCursor: string | null }> = {
      '': { models: [model(1), model(2)], nextCursor: 'c2' },
      c2: { models: [model(3)], nextCursor: 'c3' },
      c3: { models: [model(4)], nextCursor: null },
    };
    const { client } = fakeClient((_request, url) =>
      json(pages[url.searchParams.get('cursor') ?? '']),
    );
    const names: string[] = [];
    for await (const item of client.models.iterate({ projectId: PROJECT, limit: 2 })) {
      names.push(item.name);
    }
    expect(names).toEqual(['Model 1', 'Model 2', 'Model 3', 'Model 4']);
  });

  it('serializes execution filters', async () => {
    const { client, requests } = fakeClient(() => json({ executionJobs: [], nextCursor: null }));
    await client.executions.list({
      projectId: PROJECT,
      status: ['scheduled', 'running'],
      createdAfter: new Date('2026-10-01T00:00:00Z'),
      providerId: 'example-provider',
    });
    expect(Object.fromEntries(new URL(requests.at(-1)?.url ?? '').searchParams)).toEqual({
      status: 'scheduled,running',
      createdAfter: '2026-10-01T00:00:00.000Z',
      providerId: 'example-provider',
    });
  });

  it('reads the workspace activation events with filters, page by page', async () => {
    const event = (n: number) => ({
      id: `evt_01j9qmt2hy7cgsr2yefxr86p${String(n).padStart(2, '0')}`,
      type: 'PROJECT_CREATED',
      category: 'activation',
      occurredAt: '2026-10-04T12:00:00.000Z',
      actor: { type: 'api_key', userId: ME.user.id, apiKeyId: ME.principal.apiKeyId },
      source: 'api',
      organizationId: ORG,
      projectId: PROJECT,
      resource: { type: 'project', id: PROJECT },
      metadata: {},
    });
    const { client, requests } = fakeClient((_request, url) =>
      json(
        url.searchParams.get('cursor') === 'c2'
          ? { events: [event(2)], nextCursor: null }
          : { events: [event(1)], nextCursor: 'c2' },
      ),
    );
    const page = await client.workspace.events({
      type: 'PROJECT_CREATED',
      resourceId: PROJECT,
      limit: 1,
    });
    expect(page).toEqual({ data: [event(1)], nextCursor: 'c2' });
    const url = new URL(requests.at(-1)?.url ?? '');
    expect(url.pathname).toBe(`/api/v1/organizations/${ORG}/events`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '1',
      type: 'PROJECT_CREATED',
      resourceId: PROJECT,
    });
    const ids: string[] = [];
    for await (const item of client.workspace.iterateEvents({ limit: 1 })) {
      ids.push(item.id);
    }
    expect(ids).toEqual([event(1).id, event(2).id]);
  });
});

describe('generated transport', () => {
  it('is up to date with docs/api/openapi.json (run `pnpm sdk:generate`)', async () => {
    expect((await readFile(GENERATED_FILE, 'utf8')).replaceAll('\r\n', '\n')).toBe(
      await generateSdkTypes(),
    );
  });
});

describe('default API URL (F036)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is Auvryn's production API; a local stack is only an explicit override", () => {
    expect(DEFAULT_BASE_URL).toBe('https://api.auvrynspace.com');
    vi.stubEnv('AUVRYN_API_URL', undefined);
    expect(new Auvryn({ apiKey: API_KEY }).inspect().baseUrl).toBe('https://api.auvrynspace.com');
    vi.stubEnv('AUVRYN_API_URL', 'http://localhost:4000');
    expect(new Auvryn({ apiKey: API_KEY }).inspect().baseUrl).toBe('http://localhost:4000');
    expect(
      new Auvryn({ apiKey: API_KEY, baseUrl: 'http://127.0.0.1:4000' }).inspect().baseUrl,
    ).toBe('http://127.0.0.1:4000');
  });
});
