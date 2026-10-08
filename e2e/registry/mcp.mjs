// @auvryn/mcp from npm, driven by the official MCP client over stdio against the production API:
// initialize, tools/list (safety classes, no administrative tool), the read-only and execution
// gates, the providers a normal workspace sees, then the simulated sample through
// run_sample_workload (a WRITE tool), its result, provenance and telemetry.
// Uses one of the workspace's daily sample runs.
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

import {
  VERSION,
  apiUrlEnvironment,
  check,
  checkProviders,
  checkSampleJob,
  credentials,
  finish,
  record,
} from './common.mjs';

const { apiKey, projectId } = credentials();
const require = createRequire(import.meta.url);
const manifest = require('@auvryn/mcp/package.json');
const server = join(
  dirname(require.resolve('@auvryn/mcp/package.json')),
  manifest.bin['auvryn-mcp'],
);
check(
  'mcp: installed from npm at the expected version',
  manifest.version === VERSION,
  manifest.version,
);

/** Starts the server as installed; the key only travels in the child's environment. */
async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...getDefaultEnvironment(), AUVRYN_API_KEY: apiKey, ...apiUrlEnvironment(), ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk.toString('utf8')));
  const client = new Client({ name: 'auvryn-registry-e2e', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => record(await client.callTool({ name, arguments: args }));
  return {
    client,
    call,
    errorCode: (result) => result.structuredContent?.error?.code,
    async close() {
      await client.close();
      record(stderr);
    },
  };
}

const session = await connect();
try {
  const info = session.client.getServerVersion();
  check('mcp: initialize reports the published version', info?.version === VERSION, info?.version);

  const { tools } = record(await session.client.listTools());
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  check(
    'mcp: tools/list returns the documented catalog (31 tools)',
    tools.length === 31,
    String(tools.length),
  );
  const sample = byName.get('run_sample_workload');
  check(
    'mcp: run_sample_workload is a WRITE tool (not read-only, not destructive)',
    sample?._meta?.['auvryn/safety'] === 'write' &&
      sample?.annotations?.readOnlyHint === false &&
      sample?.annotations?.destructiveHint === false,
  );
  check(
    'mcp: run_execution and cancel_execution are cost-sensitive',
    ['run_execution', 'cancel_execution'].every(
      (name) => byName.get(name)?._meta?.['auvryn/safety'] === 'cost-sensitive',
    ),
  );
  check(
    'mcp: no administrative tool (owner, entitlements, provider administration, secrets)',
    !tools.some((tool) =>
      /admin|owner|entitlement|grant|revoke|secret|api_key|enable_provider/i.test(tool.name),
    ),
  );

  const sessionInfo = await session.call('get_session_info');
  check(
    'mcp: get_session_info works with the key and reports the gates closed',
    sessionInfo.structuredContent?.gates?.executionEnabled === false &&
      sessionInfo.structuredContent?.gates?.readOnly === false,
  );

  const providers = await session.call('list_providers');
  checkProviders('mcp', providers.structuredContent?.providers ?? []);

  const gated = await session.call('run_execution', {
    projectId,
    costEstimateId: 'est_00000000000000000000000000',
  });
  check(
    'mcp: run_execution is refused locally without the execution opt-in',
    session.errorCode(gated) === 'EXECUTION_DISABLED',
  );

  const started = await session.call('run_sample_workload', { projectId });
  const jobId = started.structuredContent?.execution?.id;
  check(
    'mcp: run_sample_workload starts the sample',
    started.isError !== true && typeof jobId === 'string',
  );

  let job;
  for (let attempt = 0; attempt < 5 && jobId; attempt += 1) {
    const waited = await session.call('wait_for_execution', {
      projectId,
      jobId,
      timeoutSeconds: 60,
    });
    if (waited.structuredContent?.finished) break;
  }
  if (jobId) {
    job = (await session.call('get_execution', { projectId, jobId })).structuredContent?.execution;
    checkSampleJob('mcp', job);
    const result = await session.call('get_result', { projectId, jobId });
    check('mcp: get_result returns the stored result', result.isError !== true);
  }
} catch (error) {
  check('mcp: no unexpected error', false, String(error));
} finally {
  await session.close();
}

const readOnly = await connect({ AUVRYN_MCP_READ_ONLY: 'true' });
try {
  const refused = await readOnly.call('run_sample_workload', { projectId });
  check(
    'mcp: read-only mode refuses run_sample_workload before any API call',
    readOnly.errorCode(refused) === 'READ_ONLY_MODE',
  );
} finally {
  await readOnly.close();
}

finish('mcp', apiKey);
