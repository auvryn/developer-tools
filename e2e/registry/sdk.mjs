// @auvryn/sdk from npm against the production API: authenticate, see only the Sample
// Environment, run the simulated sample idempotently, wait, read the result, provenance and
// telemetry. Uses one of the workspace's daily sample runs.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  API_OVERRIDE,
  API_URL,
  VERSION,
  check,
  checkProviders,
  checkSampleJob,
  credentials,
  finish,
  record,
} from './common.mjs';

const { apiKey, projectId } = credentials();
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(require.resolve('@auvryn/sdk/package.json'), 'utf8'));
check(
  'sdk: installed from npm at the expected version',
  manifest.version === VERSION,
  manifest.version,
);

const { Auvryn, DEFAULT_BASE_URL, AuvrynError } = await import('@auvryn/sdk');
check('sdk: the default API is production', DEFAULT_BASE_URL === API_URL, DEFAULT_BASE_URL);

const auvryn = new Auvryn({
  apiKey,
  userAgent: 'auvryn-registry-e2e/1.0',
  ...(API_OVERRIDE ? { baseUrl: API_OVERRIDE } : {}),
});
check(
  'sdk: inspect() never reveals the key',
  !JSON.stringify(auvryn.inspect()).includes(apiKey.slice(-20)),
);

try {
  const me = record(await auvryn.me());
  check('sdk: authenticated with an API key', me.principal?.kind === 'api-key');

  checkProviders('sdk', record((await auvryn.providers.list()).data));

  const idempotencyKey = Auvryn.idempotencyKey();
  const started = record(await auvryn.executions.createSample({ projectId, idempotencyKey }));
  check(
    'sdk: the sample started (202)',
    typeof started.id === 'string' && started.providerId === 'sample',
  );
  const replay = record(await auvryn.executions.createSample({ projectId, idempotencyKey }));
  check('sdk: the same idempotency key returns the same job', replay.id === started.id);

  const job = record(
    await auvryn.executions.wait({ projectId, jobId: started.id, timeoutMs: 300_000 }),
  );
  checkSampleJob('sdk', job);

  const result = record(await auvryn.results.get({ projectId, jobId: job.id }));
  check(
    'sdk: the result has stored artifacts with SHA-256',
    result.artifacts.length > 0 &&
      result.artifacts.every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256)),
  );
} catch (error) {
  const message =
    error instanceof AuvrynError ? `${error.code} (${error.status ?? 'no status'})` : String(error);
  check('sdk: no unexpected error', false, message);
}
finish('sdk', apiKey);
