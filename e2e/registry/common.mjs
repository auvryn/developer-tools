// Shared helpers for the registry end-to-end checks (e2e/registry/README.md). They run the
// packages installed FROM NPM against the production API, with a key from the environment.
import { hiddenNames } from '../../scripts/verify-packages.mjs';

export const VERSION = process.env['AUVRYN_E2E_VERSION'] ?? '0.1.0';
export const API_URL = 'https://api.auvrynspace.com';
/**
 * Only to test these scripts against a local Auvryn stack; unset in CI, where the packages'
 * production default is what runs.
 */
export const API_OVERRIDE = process.env['AUVRYN_E2E_API_URL']?.trim() || undefined;
/** The child-process environment that points a tool at the override, when there is one. */
export const apiUrlEnvironment = () => (API_OVERRIDE ? { AUVRYN_API_URL: API_OVERRIDE } : {});

/** The key and project, from the environment only (a CI secret and variable). Never printed. */
export function credentials() {
  const apiKey = process.env['AUVRYN_E2E_API_KEY']?.trim();
  const projectId = process.env['AUVRYN_E2E_PROJECT_ID']?.trim();
  if (!apiKey || !projectId) {
    process.stderr.write('Set AUVRYN_E2E_API_KEY and AUVRYN_E2E_PROJECT_ID (never commit them).\n');
    process.exit(2);
  }
  return { apiKey, projectId };
}

let failures = 0;
const transcript = [];

/** Records a check; never prints values that could hold the key. */
export function check(label, condition, detail = '') {
  process.stdout.write(
    `${condition ? 'PASS' : 'FAIL'} ${label}${detail && !condition ? ` — ${detail}` : ''}\n`,
  );
  if (!condition) failures += 1;
}

/** Keeps every response for the final scans. */
export function record(value) {
  transcript.push(typeof value === 'string' ? value : JSON.stringify(value));
  return value;
}

/** The final scans, then the exit code: no key in any output, no non-public name. */
export function finish(name, apiKey) {
  const all = transcript.join('\n');
  check(`${name}: the API key never appears in any output`, !all.includes(apiKey.slice(-20)));
  check(`${name}: no non-public provider name in any response`, hiddenNames(all) === 0);
  process.stdout.write(
    `${name}: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/** The provider list a normal workspace must see: the Sample Environment only, simulated. */
export function checkProviders(name, providers) {
  check(`${name}: providers listed`, Array.isArray(providers) && providers.length > 0);
  check(
    `${name}: only the Sample Environment is visible`,
    providers.every((provider) => provider.kind === 'sample') &&
      providers.some((provider) => provider.id === 'sample'),
    providers.map((provider) => `${provider.id}:${provider.kind}`).join(', '),
  );
  check(
    `${name}: the Sample Environment is simulated`,
    providers.find((provider) => provider.id === 'sample')?.executionEnvironment === 'simulated',
  );
}

/** A finished sample job: completed, simulated provenance, telemetry recorded. */
export function checkSampleJob(name, job) {
  check(`${name}: the sample execution completed`, job?.status === 'completed', job?.status);
  check(`${name}: it ran on the Sample Environment`, job?.providerId === 'sample');
  check(`${name}: provenance says simulated: true`, job?.telemetry?.provenance?.simulated === true);
  check(
    `${name}: provenance says executionEnvironment: simulated`,
    job?.telemetry?.provenance?.executionEnvironment === 'simulated',
  );
  check(
    `${name}: telemetry metrics recorded, each with its source`,
    Array.isArray(job?.telemetry?.metrics) &&
      job.telemetry.metrics.length > 0 &&
      job.telemetry.metrics.every((metric) => typeof metric.source === 'string'),
  );
}
