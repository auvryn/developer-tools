import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_BASE_URL } from '@auvryn/sdk';

import { ConfigurationError, readConfig } from '../src/config.js';
import { TOOLS } from '../src/server.js';
import { MCP_SERVER_VERSION } from '../src/version.js';
import {
  ARTIFACT,
  ESTIMATE,
  JOB,
  MODEL,
  PROJECT,
  PROJECT_PATH,
  SECRET,
  apiError,
  connect,
  json,
} from './support.js';

const READ_TOOLS = [
  'get_session_info',
  'list_projects',
  'get_project',
  'get_project_capabilities',
  'list_providers',
  'list_models',
  'get_model',
  'get_model_version',
  'get_sandbox_run',
  'list_areas',
  'get_area',
  'list_estimates',
  'get_estimate',
  'list_executions',
  'get_execution',
  'get_usage',
  'wait_for_validation',
  'wait_for_sandbox',
  'wait_for_execution',
  'get_result',
  'preview_result_artifact',
];
const WRITE_TOOLS = [
  'create_model',
  'upload_model_version',
  'validate_model_version',
  'run_sample_workload',
  'run_sandbox_test',
  'create_area',
  'create_estimate',
];
const COST_SENSITIVE = ['run_execution', 'cancel_execution'];
const LOCAL_FILE = ['download_result_artifact'];

const errorOf = (result: { structuredContent?: Record<string, unknown> }) =>
  (result.structuredContent?.['error'] ?? {}) as Record<string, unknown>;

describe('catalog', () => {
  it('lists every tool with its safety class, honest annotations and strict schemas', async () => {
    const mcp = await connect();
    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS, ...COST_SENSITIVE, ...LOCAL_FILE].sort(),
    );
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      const safety = tool._meta?.['auvryn/safety'];
      expect(tool.description).toContain('Safety:');
      expect(tool.description).toContain('Required API key scope');
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
      if (READ_TOOLS.includes(tool.name)) {
        expect(safety).toBe('read');
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      } else {
        expect(tool.annotations?.readOnlyHint).toBe(false);
      }
      if (COST_SENSITIVE.includes(tool.name)) {
        expect(safety).toBe('cost-sensitive');
        expect(tool.annotations?.openWorldHint).toBe(true);
        expect(tool.description).toContain('AUVRYN_MCP_EXECUTION_ENABLED');
      }
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName['cancel_execution']?.annotations?.destructiveHint).toBe(true);
    expect(byName['run_execution']?.description).toMatch(/create_estimate first/);
    expect(byName['run_execution']?.description).toMatch(/does not wait/);
    expect(byName['create_estimate']?.description).toMatch(/BEFORE run_execution/);
    // Public IDs only: UUIDs are refused by the schema.
    expect(JSON.stringify(byName['get_execution']?.inputSchema)).toContain('job_');
    await mcp.close();
  });

  it('identifies itself and lists resources, templates and prompts', async () => {
    const mcp = await connect();
    expect(mcp.client.getServerVersion()).toMatchObject({
      name: 'auvryn',
      version: MCP_SERVER_VERSION,
    });
    expect(mcp.client.getInstructions()).toMatch(
      /create_estimate → \(human review\) → run_execution/,
    );
    const { resources } = await mcp.client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['auvryn://session', 'auvryn://projects']),
    );
    const { resourceTemplates } = await mcp.client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'auvryn://projects/{projectId}',
      'auvryn://projects/{projectId}/areas',
      'auvryn://projects/{projectId}/executions',
      'auvryn://projects/{projectId}/executions/{jobId}',
      'auvryn://projects/{projectId}/executions/{jobId}/result',
      'auvryn://projects/{projectId}/models',
      'auvryn://projects/{projectId}/usage',
    ]);
    const { prompts } = await mcp.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'analyze-result',
      'inspect-execution',
      'prepare-workload',
    ]);
    const prepared = await mcp.client.getPrompt({
      name: 'prepare-workload',
      arguments: { projectId: PROJECT },
    });
    const text = (prepared.messages[0]?.content as { text: string }).text;
    expect(text).toContain('STOP. Do not call run_execution');
    await mcp.close();
  });

  it('declares one catalog in code (the docs are checked against it)', () => {
    expect(TOOLS).toHaveLength(
      READ_TOOLS.length + WRITE_TOOLS.length + COST_SENSITIVE.length + LOCAL_FILE.length,
    );
  });
});

describe('results and errors', () => {
  it('returns structured content and text for reads', async () => {
    const mcp = await connect({
      handler: () =>
        json({
          projects: [
            {
              id: PROJECT,
              organizationId: 'org_x',
              name: 'Harbor',
              slug: 'harbor',
              createdAt: '2026-10-01T12:00:00.000Z',
            },
          ],
        }),
    });
    const result = await mcp.call('list_projects');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ projects: [{ id: PROJECT, name: 'Harbor' }] });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
    await mcp.close();
  });

  it('maps API errors to code, status and request ID, without retrying 429', async () => {
    const forbidden = await connect({ handler: () => apiError(403, 'INSUFFICIENT_SCOPE') });
    const denied = await forbidden.call('create_model', { projectId: PROJECT, name: 'X' });
    expect(denied.isError).toBe(true);
    expect(errorOf(denied)).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      status: 403,
      requestId: 'req_err',
    });
    expect(denied.content[0]?.text).toContain('Request ID: req_err');
    await forbidden.close();

    const limited = await connect({
      handler: () => apiError(429, 'RATE_LIMITED', { 'retry-after': '12' }),
    });
    const result = await limited.call('list_models', { projectId: PROJECT });
    expect(errorOf(result)).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 12 });
    expect(result.content[0]?.text).toContain('Retry after 12 seconds');
    expect(limited.apiCalls()).toHaveLength(1);
    await limited.close();
  });

  it('passes capability and limit refusals through like any API error (ADR-0032)', async () => {
    const refusal = (status: number, code: string, details: Record<string, unknown>) =>
      json({ error: { code, message: `Refused ${code}.`, requestId: 'req_err', details } }, status);
    const missing = await connect({
      handler: () => refusal(403, 'ENTITLEMENT_REQUIRED', { capability: 'own-model-upload' }),
    });
    const upload = await missing.call('create_model', { projectId: PROJECT, name: 'X' });
    expect(upload.isError).toBe(true);
    expect(errorOf(upload)).toMatchObject({
      code: 'ENTITLEMENT_REQUIRED',
      status: 403,
      details: { capability: 'own-model-upload' },
    });
    // Refused by the API: the MCP server neither retries nor decides on its own.
    expect(missing.apiCalls()).toHaveLength(1);
    await missing.close();

    const full = await connect({
      handler: () => refusal(409, 'WORKSPACE_LIMIT_REACHED', { limit: 'models', used: 5, max: 5 }),
    });
    const create = await full.call('create_model', { projectId: PROJECT, name: 'Y' });
    expect(errorOf(create)).toMatchObject({
      code: 'WORKSPACE_LIMIT_REACHED',
      status: 409,
      details: { limit: 'models', used: 5, max: 5 },
    });
    await full.close();
  });

  it('refuses malformed IDs (UUIDs) before any request', async () => {
    const mcp = await connect();
    const result = await mcp.call('get_execution', {
      projectId: PROJECT,
      jobId: '01926f4c-0000-7000-8000-000000000001',
    });
    expect(result.isError).toBe(true);
    expect(mcp.apiCalls()).toHaveLength(0);
    await mcp.close();
  });
});

describe('execution gate and read-only mode', () => {
  const created = () => json({ id: JOB, status: 'created', dispatch: 'queued' }, 202);

  it('disables run_execution and cancel_execution by default, before any request', async () => {
    const mcp = await connect({ handler: created });
    for (const [name, args] of [
      ['run_execution', { projectId: PROJECT, costEstimateId: ESTIMATE }],
      ['cancel_execution', { projectId: PROJECT, jobId: JOB }],
    ] as const) {
      const result = await mcp.call(name, args);
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('EXECUTION_DISABLED');
    }
    expect(mcp.requests).toHaveLength(0);
    await mcp.close();
  });

  it('runs an execution when enabled, with the given idempotency key', async () => {
    const mcp = await connect({ env: { AUVRYN_MCP_EXECUTION_ENABLED: 'true' }, handler: created });
    const result = await mcp.call('run_execution', {
      projectId: PROJECT,
      costEstimateId: ESTIMATE,
      idempotencyKey: 'agent-run-1',
    });
    expect(result.structuredContent).toMatchObject({
      execution: { id: JOB },
      idempotencyKey: 'agent-run-1',
    });
    const post = mcp.apiCalls().find((request) => request.method === 'POST');
    expect(post?.headers.get('idempotency-key')).toBe('agent-run-1');
    expect(await post?.json()).toEqual({ costEstimateId: ESTIMATE });
    await mcp.close();
  });

  it('generates one key per invocation, reused by retries of that invocation, and returns it', async () => {
    let attempt = 0;
    const mcp = await connect({
      env: { AUVRYN_MCP_EXECUTION_ENABLED: 'true' },
      handler: () => ((attempt += 1) === 1 ? apiError(503, 'INTERNAL_ERROR') : created()),
    });
    const result = await mcp.call('run_execution', {
      projectId: PROJECT,
      costEstimateId: ESTIMATE,
    });
    const used = result.structuredContent?.['idempotencyKey'];
    expect(used).toMatch(/^mcp_[A-Za-z0-9_-]{24}$/);
    const keys = mcp.apiCalls().map((request) => request.headers.get('idempotency-key'));
    expect(keys).toEqual([used, used]);
    const second = await mcp.call('run_execution', {
      projectId: PROJECT,
      costEstimateId: ESTIMATE,
    });
    expect(second.structuredContent?.['idempotencyKey']).not.toBe(used);
    await mcp.close();
  });

  it('refuses every write locally in read-only mode', async () => {
    const mcp = await connect({
      env: { AUVRYN_MCP_READ_ONLY: 'true', AUVRYN_MCP_EXECUTION_ENABLED: 'true' },
    });
    const result = await mcp.call('create_model', { projectId: PROJECT, name: 'Nope' });
    expect(errorOf(result).code).toBe('READ_ONLY_MODE');
    expect(
      errorOf(await mcp.call('run_execution', { projectId: PROJECT, costEstimateId: ESTIMATE }))
        .code,
    ).toBe('READ_ONLY_MODE');
    expect(mcp.requests).toHaveLength(0);
    await mcp.close();
  });
});

describe('file boundary', () => {
  let base = '';
  let root = '';
  let outsideFile = '';

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'auvryn-mcp-'));
    root = join(base, 'root');
    await mkdir(join(root, 'models'), { recursive: true });
    await mkdir(join(base, 'outside'));
    await writeFile(join(root, 'models', 'ok.onnx'), Buffer.from([1, 2, 3]));
    outsideFile = join(base, 'outside', 'secret.onnx');
    await writeFile(outsideFile, 'not for agents');
    // A directory link from inside the root to outside it (a junction on Windows: no privilege needed).
    await symlink(join(base, 'outside'), join(root, 'escape'), 'junction');
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const upload = (filePath: string) => ({ projectId: PROJECT, modelId: MODEL, filePath });

  it('has no file access without AUVRYN_MCP_FILE_ROOT', async () => {
    const mcp = await connect();
    expect(errorOf(await mcp.call('upload_model_version', upload('models/ok.onnx'))).code).toBe(
      'FILE_ACCESS_DISABLED',
    );
    expect(mcp.requests).toHaveLength(0);
    await mcp.close();
  });

  it('refuses .., absolute and symlink escapes before creating anything', async () => {
    const mcp = await connect({ env: { AUVRYN_MCP_FILE_ROOT: root } });
    for (const path of [
      '../outside/secret.onnx',
      outsideFile,
      'escape/secret.onnx',
      'models/../../outside/secret.onnx',
    ]) {
      const result = await mcp.call('upload_model_version', upload(path));
      expect(errorOf(result).code, path).toBe('PATH_OUTSIDE_FILE_ROOT');
    }
    expect(
      errorOf(await mcp.call('upload_model_version', upload('models/missing.onnx'))).code,
    ).toBe('FILE_NOT_FOUND');
    // Nothing reached Auvryn: no version was created, nothing was read.
    expect(mcp.requests).toHaveLength(0);
    await mcp.close();
  });

  it('downloads only inside the root, never over an existing file unless asked', async () => {
    const content = Buffer.from('{"detections":[]}');
    const sha = (await import('node:crypto')).createHash('sha256').update(content).digest('hex');
    const mcp = await connect({
      env: { AUVRYN_MCP_FILE_ROOT: root },
      handler: (_request, url) =>
        url.pathname.endsWith('/content')
          ? new Response(Readable.toWeb(Readable.from([content])) as ReadableStream, {
              headers: { 'content-type': 'application/json' },
            })
          : json({
              id: ARTIFACT,
              name: 'd.json',
              mediaType: 'application/json',
              sizeBytes: content.length,
              sha256: sha,
            }),
    });
    const ref = { projectId: PROJECT, jobId: JOB, artifactId: ARTIFACT };
    const saved = await mcp.call('download_result_artifact', {
      ...ref,
      destinationPath: 'out.json',
    });
    expect(saved.structuredContent).toMatchObject({ sha256: sha, sizeBytes: content.length });
    expect(await readFile(join(root, 'out.json'), 'utf8')).toBe(content.toString());
    expect(
      errorOf(await mcp.call('download_result_artifact', { ...ref, destinationPath: 'out.json' }))
        .code,
    ).toBe('FILE_EXISTS');
    expect(
      (
        await mcp.call('download_result_artifact', {
          ...ref,
          destinationPath: 'out.json',
          overwrite: true,
        })
      ).isError,
    ).toBeFalsy();
    for (const path of ['../out.json', join(base, 'outside', 'x.json'), 'escape/x.json']) {
      expect(
        errorOf(await mcp.call('download_result_artifact', { ...ref, destinationPath: path })).code,
        path,
      ).toBe('PATH_OUTSIDE_FILE_ROOT');
    }
    await mcp.close();
  });
});

describe('result handling', () => {
  const big = Buffer.from(JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => i) }));
  const handler = (mediaType: string) => (_request: Request, url: URL) =>
    url.pathname.endsWith('/content')
      ? new Response(Readable.toWeb(Readable.from([big])) as ReadableStream)
      : json({ id: ARTIFACT, name: 'a', mediaType, sizeBytes: big.length, sha256: '0'.repeat(64) });

  it('previews at most maxBytes of a textual artifact and says when it is truncated', async () => {
    const mcp = await connect({ handler: handler('application/json') });
    const result = await mcp.call('preview_result_artifact', {
      projectId: PROJECT,
      jobId: JOB,
      artifactId: ARTIFACT,
      maxBytes: 100,
    });
    expect(result.structuredContent).toMatchObject({ previewBytes: 100, truncated: true });
    expect((result.structuredContent?.['preview'] as string).length).toBe(100);
    await mcp.close();
  });

  it('refuses to preview binary artifacts', async () => {
    const mcp = await connect({ handler: handler('application/octet-stream') });
    const result = await mcp.call('preview_result_artifact', {
      projectId: PROJECT,
      jobId: JOB,
      artifactId: ARTIFACT,
    });
    expect(errorOf(result).code).toBe('UNSUPPORTED_PREVIEW');
    expect(mcp.apiCalls().some((request) => request.url.endsWith('/content'))).toBe(false);
    await mcp.close();
  });

  it('returns finished=false with the last state when a wait times out', async () => {
    const mcp = await connect({ handler: () => json({ id: JOB, status: 'running' }) });
    const result = await mcp.call('wait_for_execution', {
      projectId: PROJECT,
      jobId: JOB,
      timeoutSeconds: 1,
    });
    expect(result.structuredContent).toMatchObject({
      finished: false,
      execution: { status: 'running' },
    });
    await mcp.close();
  });
});

describe('resources', () => {
  it('reads bounded JSON through the same API authorization', async () => {
    const mcp = await connect({
      handler: (_request, url) =>
        url.pathname === `${PROJECT_PATH}/execution-jobs`
          ? json({ executionJobs: [{ id: JOB, status: 'running' }], nextCursor: 'c2' })
          : apiError(404, 'PROJECT_NOT_FOUND'),
    });
    const read = await mcp.client.readResource({ uri: `auvryn://projects/${PROJECT}/executions` });
    const content = read.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe('application/json');
    expect(JSON.parse(content.text)).toMatchObject({ items: [{ id: JOB }], nextCursor: 'c2' });
    expect(new URL(mcp.apiCalls()[0]?.url ?? '').searchParams.get('limit')).toBe('50');
    await expect(mcp.client.readResource({ uri: `auvryn://projects/${PROJECT}` })).rejects.toThrow(
      /PROJECT_NOT_FOUND/,
    );
    await expect(mcp.client.readResource({ uri: 'auvryn://projects/not-an-id' })).rejects.toThrow(
      /prj_/,
    );
    await mcp.close();
  });
});

describe('secrets and logs', () => {
  it('never puts the API key in results, errors or logs; logs only tool, status, duration and public IDs', async () => {
    const mcp = await connect({ handler: () => apiError(401, 'INVALID_AUTHENTICATION') });
    const failed = await mcp.call('list_models', { projectId: PROJECT });
    const session = await mcp.call('get_session_info');
    for (const text of [JSON.stringify(failed), JSON.stringify(session), mcp.logs.join('')]) {
      expect(text).not.toContain(SECRET);
    }
    const line = JSON.parse(
      mcp.logs.find((entry) => entry.includes('"list_models"')) ?? '{}',
    ) as Record<string, unknown>;
    expect(line).toMatchObject({
      event: 'tool',
      tool: 'list_models',
      status: 'error',
      code: 'INVALID_AUTHENTICATION',
      ids: { projectId: PROJECT },
    });
    expect(Object.keys(line).sort()).toEqual([
      'code',
      'durationMs',
      'event',
      'ids',
      'requestId',
      'service',
      'status',
      'time',
      'tool',
    ]);
    await mcp.close();
  });
});

describe('configuration', () => {
  it('requires the API key from the environment and validates the gates', () => {
    expect(() => readConfig({})).toThrow(ConfigurationError);
    expect(() => readConfig({ AUVRYN_API_KEY: 'x', AUVRYN_MCP_FILE_ROOT: 'relative/dir' })).toThrow(
      /absolute/,
    );
    expect(() => readConfig({ AUVRYN_API_KEY: 'x', AUVRYN_MCP_EXECUTION_ENABLED: 'yes' })).toThrow(
      /"true" or "false"/,
    );
    // No AUVRYN_API_URL: the SDK's default, Auvryn's production API (F036).
    expect(readConfig({ AUVRYN_API_KEY: 'x' }).apiUrl).toBeUndefined();
    expect(DEFAULT_BASE_URL).toBe('https://api.auvrynspace.com');
    expect(readConfig({ AUVRYN_API_KEY: 'x' })).toMatchObject({
      executionEnabled: false,
      readOnly: false,
      fileRoot: undefined,
    });
  });

  it('reports the package version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
  });
});

describe('documentation', () => {
  it('docs/mcp/tools.md lists every tool with its scope', async () => {
    const doc = await readFile(new URL('../../../docs/mcp/tools.md', import.meta.url), 'utf8');
    for (const tool of TOOLS) {
      const row = doc.split('\n').find((line) => line.startsWith(`| \`${tool.name}\``));
      expect(row, tool.name).toBeDefined();
      expect(row).toContain(tool.scope === null ? '| —' : `\`${tool.scope}\``);
    }
    expect(doc).toContain(`${String(TOOLS.length)} tools`);
  });
});

describe('providers (F036)', () => {
  it("list_providers returns exactly the API's list for the key's workspace", async () => {
    const sample = {
      id: 'sample',
      name: 'Sample Environment',
      kind: 'sample',
      requiredCapabilities: ['sample-workload'],
      types: ['compute'],
      executionEnvironment: 'simulated',
      security: {},
    };
    const session = await connect({
      handler: (_request, url) =>
        url.pathname === '/api/v1/providers'
          ? json({ providers: [sample] })
          : apiError(500, 'INTERNAL_ERROR'),
    });
    try {
      const result = await session.call('list_providers');
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ providers: [sample] });
      // No workspace is chosen or widened by the server: the API key's own.
      expect(session.apiCalls().map((request) => new URL(request.url).search)).toEqual(['']);
    } finally {
      await session.close();
    }
  });
});

describe('run_sample_workload (F036)', () => {
  const sample = `${PROJECT_PATH}/sample-workloads`;
  const job = { id: JOB, status: 'created', providerId: 'sample', dispatch: 'queued' };

  it('is a WRITE: refused in read-only mode, no execution opt-in needed, empty body', async () => {
    const readOnly = await connect({
      env: { AUVRYN_MCP_READ_ONLY: 'true' },
      handler: () => json(job, 202),
    });
    try {
      const refused = await readOnly.call('run_sample_workload', { projectId: PROJECT });
      expect(refused.isError).toBe(true);
      expect(readOnly.apiCalls()).toHaveLength(0);
    } finally {
      await readOnly.close();
    }

    const session = await connect({
      handler: (request, url) =>
        url.pathname === sample && request.method === 'POST'
          ? json(job, 202)
          : apiError(500, 'INTERNAL_ERROR'),
    });
    try {
      const result = await session.call('run_sample_workload', { projectId: PROJECT });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ execution: { id: JOB } });
      const [call] = session.apiCalls();
      expect(new URL(call?.url ?? '').pathname).toBe(sample);
      expect(await call?.json()).toEqual({});
      expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
      const tool = (await session.client.listTools()).tools.find(
        (candidate) => candidate.name === 'run_sample_workload',
      );
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool?._meta).toMatchObject({
        'auvryn/safety': 'write',
        'auvryn/scope': 'executions:write',
      });
    } finally {
      await session.close();
    }
  });
});
