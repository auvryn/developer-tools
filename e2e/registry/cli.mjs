// @auvryn/cli from npm against the production API: version, help, configuration errors, JSON and
// human output, the simulated sample with --wait, the result, provenance and telemetry, and the
// documented exit codes. Uses one of the workspace's daily sample runs.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import {
  API_URL,
  apiUrlEnvironment,
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
const packageDirectory = dirname(require.resolve('@auvryn/cli/package.json'));
const manifest = require('@auvryn/cli/package.json');
const bin = join(packageDirectory, manifest.bin.auvryn);

/** Runs `auvryn` exactly as installed; the key only ever travels in the child's environment. */
function auvryn(
  args,
  env = { AUVRYN_API_KEY: apiKey, AUVRYN_PROJECT_ID: projectId, ...apiUrlEnvironment() },
) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 360_000,
  });
  record(result.stdout);
  record(result.stderr);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

check(
  'cli: installed from npm at the expected version',
  manifest.version === VERSION,
  manifest.version,
);
const version = auvryn(['--version'], {});
check(
  'cli: --version prints the version (exit 0)',
  version.code === 0 && version.stdout.includes(VERSION),
);
const help = auvryn(['--help'], {});
check(
  'cli: --help documents the production API default',
  help.code === 0 && help.stdout.includes(API_URL),
);
const missing = auvryn(['--json', 'providers', 'list'], {});
check('cli: no AUVRYN_API_KEY → exit 2, nothing sent', missing.code === 2);

const auth = auvryn(['--json', 'auth', 'status']);
check(
  'cli: auth status with the key from the environment (exit 0)',
  auth.code === 0 && json(auth.stdout) !== undefined,
);

const providers = auvryn(['--json', 'providers', 'list']);
checkProviders('cli', json(providers.stdout)?.data ?? []);

const sample = auvryn(['--json', 'executions', 'sample', '--wait', '--timeout', '5m']);
const job = json(sample.stdout);
check(
  'cli: executions sample --wait finishes completed (exit 0)',
  sample.code === 0,
  `exit ${sample.code}`,
);
checkSampleJob('cli', job);

if (job?.id) {
  const human = auvryn(['executions', 'get', job.id]);
  check(
    'cli: human output shows the environment and Simulated: yes',
    /Simulated:\s+yes/.test(human.stdout),
  );
  const result = auvryn(['--json', 'results', 'get', job.id]);
  check(
    'cli: results get returns stored artifacts (exit 0)',
    result.code === 0 && (json(result.stdout)?.artifacts?.length ?? 0) > 0,
  );
}
const unknown = auvryn(['--json', 'executions', 'get', 'job_00000000000000000000000000']);
check(
  'cli: an unknown job → exit 1, the API error as JSON on stdout',
  unknown.code === 1 && /NOT_FOUND/.test(json(unknown.stdout)?.error?.code ?? ''),
);

finish('cli', apiKey);
