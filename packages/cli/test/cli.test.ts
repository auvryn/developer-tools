import { describe, expect, it } from 'vitest';

import { parseDuration } from '../src/context.js';
import { money, table } from '../src/format.js';
import { runCli } from '../src/program.js';

const API_KEY = `auv_${'0'.repeat(26)}_${'B'.repeat(42)}w`;
const ORG = 'org_01j9qmt2hy7cgsr2yefxr86ptb';
const PROJECT = 'prj_01j9qmt2hy7cgsr2yefxr86ptc';
const ME = {
  user: {
    id: 'usr_01j9qmt2hy7cgsr2yefxr86pte',
    email: null,
    emailVerified: false,
    displayName: null,
  },
  principal: {
    kind: 'api-key',
    apiKeyId: 'key_01j9qmt2hy7cgsr2yefxr86ptd',
    organizationId: ORG,
    projectId: null,
    scopes: ['projects:read'],
  },
  session: { authenticatedAt: '2026-10-01T12:00:00.000Z', expiresAt: null },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_cli', ...headers },
  });

async function run(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    handler?: (request: Request, url: URL) => Response | Promise<Response>;
  } = {},
) {
  let stdout = '';
  let stderr = '';
  const requests: Request[] = [];
  const code = await runCli(argv, {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env: { AUVRYN_API_KEY: API_KEY, AUVRYN_PROJECT_ID: PROJECT, ...options.env },
    version: '0.1.0',
    fetch: async (request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/me') {
        return json(ME);
      }
      return (options.handler ?? (() => json({ error: 'unexpected' }, 500)))(request, url);
    },
  });
  // The key never reaches any output.
  expect(stdout + stderr).not.toContain(API_KEY.slice(31));
  return { code, stdout, stderr, requests };
}

describe('the auvryn command', () => {
  it('prints its version and help with exit 0', async () => {
    expect(await run(['--version'])).toMatchObject({ code: 0, stdout: '0.1.0\n' });
    const help = await run(['executions', 'wait', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--timeout <duration>');
  });

  it('fails with exit 2 before any request when configuration is missing or wrong', async () => {
    for (const [argv, env, message] of [
      [['projects', 'list'], { AUVRYN_API_KEY: undefined }, 'AUVRYN_API_KEY is not set'],
      [['projects', 'list'], { AUVRYN_API_KEY: 'sk-not-auvryn' }, 'not an Auvryn API key'],
      [['models', 'list'], { AUVRYN_PROJECT_ID: undefined }, 'No project'],
      [['projects', 'list', '--api-url', 'not a url'], {}, 'baseUrl must be'],
      [['executions', 'run'], {}, 'Pass either --estimate'],
      [
        ['executions', 'run', '--estimate', 'est_1', '--provider', 'x'],
        {},
        'apply only to --model-version',
      ],
      [['executions', 'wait', 'job_1', '--timeout', 'soon'], {}, 'Invalid duration'],
      [['models', 'list', '--limit', '500'], {}, '--limit must be'],
    ] as const) {
      const result = await run([...argv], { env });
      expect(result.code, argv.join(' ')).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.requests).toHaveLength(0);
    }
    expect((await run(['models', 'create'])).code).toBe(2);
    expect((await run(['nonsense'])).code).toBe(2);
  });

  it('prints only JSON on stdout with --json, and progress only on stderr', async () => {
    const result = await run(['projects', 'list', '--json'], {
      handler: () =>
        json({
          projects: [
            {
              id: PROJECT,
              organizationId: ORG,
              name: 'Harbor',
              slug: 'harbor',
              createdAt: '2026-10-01T12:00:00.000Z',
            },
          ],
        }),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      data: [expect.objectContaining({ id: PROJECT, name: 'Harbor' })],
      nextCursor: null,
    });
    const request = result.requests.at(-1);
    expect(request?.headers.get('user-agent')).toBe('auvryn-cli/0.1.0 auvryn-js/0.1.0');
  });

  it('prints a human table without --json', async () => {
    const result = await run(['projects', 'list'], {
      handler: () =>
        json({
          projects: [
            {
              id: PROJECT,
              organizationId: ORG,
              name: 'Harbor',
              slug: 'harbor',
              createdAt: '2026-10-01T12:00:00.000Z',
            },
          ],
        }),
    });
    expect(result.stdout).toMatch(/^ID\s+NAME\s+SLUG\s+CREATED\n/);
    expect(result.stdout).toContain(PROJECT);
  });

  it('reports API errors with code, status and request ID (exit 1), as JSON with --json', async () => {
    const failing = () =>
      json(
        {
          error: {
            code: 'INVALID_AUTHENTICATION',
            message: 'The provided credentials are invalid or expired.',
            requestId: 'req_401',
            details: {},
          },
        },
        401,
      );
    const human = await run(['models', 'list'], { handler: failing });
    expect(human.code).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('Code: INVALID_AUTHENTICATION');
    expect(human.stderr).toContain('Request ID: req_401');
    const machine = await run(['models', 'list', '--json'], { handler: failing });
    expect(machine.code).toBe(1);
    expect((JSON.parse(machine.stdout) as { error: unknown }).error).toMatchObject({
      code: 'INVALID_AUTHENTICATION',
      status: 401,
      requestId: 'req_401',
    });
  });

  it('explains a reached workspace limit in plain words, keeping the code (ADR-0032)', async () => {
    const result = await run(['models', 'list'], {
      handler: () =>
        json(
          {
            error: {
              code: 'WORKSPACE_LIMIT_REACHED',
              message: 'This workspace has reached its model limit. Current usage: 5 of 5.',
              requestId: 'req_limit',
              details: { limit: 'models', used: 5, max: 5 },
            },
          },
          409,
        ),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Error: This workspace has reached its model limit. Current usage: 5 of 5.',
    );
    expect(result.stderr).toContain('Code: WORKSPACE_LIMIT_REACHED');
    expect(result.stderr).toContain('Limit: models');
  });

  it('names the missing capability of a refused upload (ADR-0032)', async () => {
    const result = await run(['models', 'list'], {
      handler: () =>
        json(
          {
            error: {
              code: 'ENTITLEMENT_REQUIRED',
              message:
                "Model upload isn't enabled for this workspace. Contact Auvryn to request access.",
              requestId: 'req_cap',
              details: { capability: 'own-model-upload' },
            },
          },
          403,
        ),
    });
    expect(result.stderr).toContain("Error: Model upload isn't enabled for this workspace.");
    expect(result.stderr).toContain('Code: ENTITLEMENT_REQUIRED');
    expect(result.stderr).toContain('Capability: own-model-upload');
  });

  it('takes the model version as --model-version (never the global --version flag)', async () => {
    const result = await run(
      ['estimates', 'create', '--model-version', 'mdlver_1', '--provider', 'example', '--json'],
      {
        handler: () =>
          json(
            {
              id: 'est_1',
              amountMinor: '101',
              currency: 'USD',
              providerId: 'example',
              modelVersionId: 'mdlver_1',
            },
            201,
          ),
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'est_1' });
    const create = result.requests.find((request) => request.method === 'POST');
    expect(await create?.json()).toEqual({ modelVersionId: 'mdlver_1', providerId: 'example' });
  });

  it('sends --idempotency-key on executions run, and returns at once', async () => {
    const result = await run(
      ['executions', 'run', '--estimate', 'est_1', '--idempotency-key', 'nightly-42', '--json'],
      {
        handler: () => json({ id: 'job_1', status: 'created', dispatch: 'queued' }, 202),
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 'job_1' });
    const create = result.requests.find((request) => request.method === 'POST');
    expect(create?.headers.get('idempotency-key')).toBe('nightly-42');
    expect(await create?.json()).toEqual({ costEstimateId: 'est_1' });
    expect(
      result.requests.filter(
        (request) => request.method === 'GET' && request.url.includes('/execution-jobs/'),
      ),
    ).toHaveLength(0);
  });

  it('exits 3 when an awaited execution ends failed, still printing it', async () => {
    const result = await run(['executions', 'wait', 'job_1', '--json', '--quiet'], {
      handler: () =>
        json({
          id: 'job_1',
          status: 'failed',
          failure: { code: 'PROVIDER_EXECUTION_FAILED', message: 'The provider failed.' },
        }),
    });
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'failed' });
    expect(result.stderr).toBe('');
  });

  it('exits 1 with WAIT_TIMEOUT when the wait times out', async () => {
    const result = await run(['executions', 'wait', 'job_1', '--timeout', '300ms', '--quiet'], {
      handler: () => json({ id: 'job_1', status: 'running' }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Code: WAIT_TIMEOUT');
  });
});

describe('formatting', () => {
  it('parses durations', () => {
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(() => parseDuration('0')).toThrow();
    expect(() => parseDuration('-5s')).toThrow();
  });

  it('formats money with the currency decimals, from minor units', () => {
    expect(money('4250', 'EUR')).toBe('42.50 EUR');
    expect(money('5', 'USD')).toBe('0.05 USD');
    expect(money('1200', 'JPY')).toBe('1200 JPY');
    expect(money('-101', 'USD')).toBe('-1.01 USD');
  });

  it('aligns tables', () => {
    expect(
      table(
        [
          { id: 'a', name: 'Long name' },
          { id: 'bbb', name: null },
        ],
        [
          ['ID', 'id'],
          ['Name', 'name'],
        ],
        'none',
      ),
    ).toBe('ID   NAME\na    Long name\nbbb  -');
  });
});

describe('providers (F036)', () => {
  const SAMPLE = {
    id: 'sample',
    name: 'Sample Environment',
    kind: 'sample',
    requiredCapabilities: ['sample-workload'],
    types: ['compute'],
    executionEnvironment: 'simulated',
    security: {},
  };

  it("shows exactly the API's list for the key's workspace, and never names a provider itself", async () => {
    for (const json_ of [true, false]) {
      const { code, stdout, requests } = await run(
        json_ ? ['--json', 'providers', 'list'] : ['providers', 'list'],
        {
          handler: (_request, url) =>
            url.pathname === '/api/v1/providers' ? json({ providers: [SAMPLE] }) : json({}, 500),
        },
      );
      expect(code).toBe(0);
      // The workspace is the API key's own: no workspace is chosen or widened by the CLI.
      const calls = requests.filter((request) => new URL(request.url).pathname !== '/api/v1/me');
      expect(calls.map((request) => new URL(request.url).search)).toEqual(['']);
      if (json_) {
        expect((JSON.parse(stdout) as { data: unknown[] }).data).toEqual([SAMPLE]);
      } else {
        expect(stdout).toContain('Sample Environment');
      }
    }
  });
});

describe('default API URL (F036)', () => {
  it("calls Auvryn's production API unless AUVRYN_API_URL or --api-url says otherwise", async () => {
    const help = await run(['--help']);
    expect(help.stdout).toContain('default https://api.auvrynspace.com');
    expect(help.stdout).not.toContain('localhost');

    const handler = (_request: Request, url: URL) =>
      url.pathname === '/api/v1/providers' ? json({ providers: [] }) : json({}, 500);
    const production = await run(['--json', 'providers', 'list'], { handler });
    expect(production.code).toBe(0);
    expect(new Set(production.requests.map((request) => new URL(request.url).origin))).toEqual(
      new Set(['https://api.auvrynspace.com']),
    );
    const local = await run(['--json', '--api-url', 'http://localhost:4000', 'providers', 'list'], {
      handler,
    });
    expect(local.code).toBe(0);
    expect(new Set(local.requests.map((request) => new URL(request.url).origin))).toEqual(
      new Set(['http://localhost:4000']),
    );
  });
});

describe('executions sample (F036)', () => {
  it('starts the simulated sample with an empty body and says it is simulated', async () => {
    const sample = `/api/v1/organizations/${ORG}/projects/${PROJECT}/sample-workloads`;
    const job = {
      id: 'job_01j9qmt2hy7cgsr2yefxr86ptg',
      status: 'created',
      providerId: 'sample',
      workloadKind: 'sample',
      dispatch: 'queued',
    };
    const human = await run(['executions', 'sample', '--idempotency-key', 'k1'], {
      handler: (request, url) =>
        url.pathname === sample && request.method === 'POST' ? json(job, 202) : json({}, 500),
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Simulated');
    const calls = human.requests.filter((request) => new URL(request.url).pathname === sample);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('Idempotency-Key')).toBe('k1');
    expect(await calls[0]?.json()).toEqual({});

    const machine = await run(['--json', 'executions', 'sample'], {
      handler: (request, url) =>
        url.pathname === sample && request.method === 'POST' ? json(job, 202) : json({}, 500),
    });
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({ id: job.id, providerId: 'sample' });
  });
});

describe('executions get (F036)', () => {
  it('shows provenance and telemetry of a finished job without --json', async () => {
    const jobId = 'job_01j9qmt2hy7cgsr2yefxr86ptg';
    const { code, stdout } = await run(['executions', 'get', jobId], {
      handler: (_request, url) =>
        url.pathname.endsWith(`/execution-jobs/${jobId}`)
          ? json({
              id: jobId,
              status: 'completed',
              providerId: 'sample',
              modelVersionId: null,
              costEstimateId: null,
              failure: null,
              createdAt: '2026-10-07T21:28:00.000Z',
              completedAt: '2026-10-07T21:28:05.000Z',
              telemetry: {
                outcome: 'succeeded',
                provenance: {
                  provider: { id: 'sample', kind: 'sample', types: ['compute'] },
                  executionEnvironment: 'simulated',
                  simulated: true,
                },
                metrics: [
                  {
                    metric: 'total_latency_ms',
                    label: null,
                    value: 5000,
                    unit: 'millisecond',
                    source: 'measured_by_auvryn',
                  },
                ],
                recordedAt: '2026-10-07T21:28:05.000Z',
              },
            })
          : json({}, 500),
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Environment:\s+simulated/);
    expect(stdout).toMatch(/Simulated:\s+yes/);
    expect(stdout).toMatch(/Telemetry:\s+1 metrics/);
  });
});
