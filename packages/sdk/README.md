# @auvryn/sdk

The official TypeScript SDK for the [Auvryn](https://auvrynspace.com) Developer API (v1):
validate ONNX models, run them as durable ExecutionJobs and read their verified results, provenance
and telemetry.

- Node.js 24 or later, ESM only (`import`, no `require`).
- One runtime dependency (`openapi-fetch`); types generated from the public OpenAPI 3.1 document.
- Version 0.x: minor versions may change the API (see [Versioning](#versioning)).

## Install

```bash
npm install @auvryn/sdk
```

## Authenticate

Create an API key in the Auvryn web app (**Workspace → Developer → API keys**). The secret is
shown once; store it as an environment variable, never in code:

```bash
export AUVRYN_API_KEY="auv_…"         # the key
export AUVRYN_PROJECT_ID="prj_…"      # a project of the key's workspace
```

A key belongs to one workspace and carries scopes (`models:write`, `executions:write`,
`results:read`, …). The SDK keeps it in memory only and never prints it.

## Quickstart

Every workspace can run Auvryn's sample model on the **Sample Environment**. That execution is
**simulated**: no model runs on real hardware, and its provenance says `simulated: true`. It shows
the whole lifecycle — create, wait, result, provenance, telemetry — without any setup.

```ts
import { Auvryn } from '@auvryn/sdk';

const auvryn = new Auvryn(); // reads AUVRYN_API_KEY; defaults to https://api.auvrynspace.com
const projectId = process.env.AUVRYN_PROJECT_ID!;

// 1. Start the sample (202: it returns at once). Reuse the key if you retry.
const started = await auvryn.executions.createSample({
  projectId,
  idempotencyKey: Auvryn.idempotencyKey(),
});

// 2. Wait for a final status: completed, failed or cancelled.
const job = await auvryn.executions.wait({ projectId, jobId: started.id });

// 3. The result, stored by Auvryn with its size and SHA-256.
const result = await auvryn.results.get({ projectId, jobId: job.id });
console.log(
  job.status,
  result.artifacts.map((artifact) => artifact.name),
);

// 4. Provenance and telemetry: every fact keeps its source.
console.log(job.telemetry?.provenance); // { executionEnvironment: 'simulated', simulated: true, … }
console.log(job.telemetry?.metrics); // [{ metric, value, unit, source }, …]
```

The sample needs the workspace's `sample-workload` capability (on by default), the key's
`executions:write` scope (plus `executions:read` and `results:read` to follow it) and counts toward
a daily sample-run limit (5 per UTC day).

## Your own model

Upload and validate your ONNX model; optionally test it in Auvryn's isolated sandbox (it runs once,
with generated inputs, and nothing is billed):

```ts
const model = await auvryn.models.create({ projectId, name: 'My detector' });
const { version } = await auvryn.models.uploadVersion({
  projectId,
  modelId: model.id,
  file: './model.onnx', // a path, or bytes with `filename`
});
await auvryn.models.validate({ projectId, modelId: model.id, versionId: version.id });
const validation = await auvryn.models.waitForValidation({
  projectId,
  modelId: model.id,
  versionId: version.id,
});
console.log(validation.status); // 'valid', 'invalid' (with the reasons) or 'failed'
```

Running your own model needs a provider your workspace can use. `auvryn.providers.list()` returns
exactly those; a provider that is not listed for your workspace answers `404 PROVIDER_NOT_FOUND`.
Auvryn never picks a provider for you.

## Surface

Every method takes one object; `projectId` scopes project resources. Every call also accepts
`signal` (an `AbortSignal`) and `requestId` (your own `X-Request-Id`).

| Resource            | Methods                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auvryn`            | `me()`, `organization()`, `organizationId()`, `inspect()`, `Auvryn.idempotencyKey()`                                                                                                  |
| `auvryn.projects`   | `list()`, `get({ projectId })`                                                                                                                                                        |
| `auvryn.providers`  | `list()` (the providers your workspace can use)                                                                                                                                       |
| `auvryn.workspace`  | `entitlements()`, `events()`, `iterateEvents()`                                                                                                                                       |
| `auvryn.models`     | `list`, `iterate`, `get`, `create`, `listVersions`, `getVersion`, `createVersion`, `getArtifact`, `uploadArtifact`, `uploadVersion`, `validate`, `getValidation`, `waitForValidation` |
| `auvryn.sandbox`    | `run`, `get`, `list`, `wait`                                                                                                                                                          |
| `auvryn.areas`      | `list`, `iterate`, `get`, `create`, `update`                                                                                                                                          |
| `auvryn.estimates`  | `list`, `iterate`, `get`, `create`                                                                                                                                                    |
| `auvryn.executions` | `list`, `iterate`, `get`, `create`, `createSample` (simulated), `cancel`, `wait`                                                                                                      |
| `auvryn.results`    | `get`, `getArtifact`, `downloadArtifact` (stream), `saveArtifact` (file, SHA-256 verified)                                                                                            |
| `auvryn.usage`      | `listEvents`, `iterateEvents`, `listLedger`, `iterateLedger` (usage and provider cost estimates; not billing)                                                                         |

Lists are paginated (`limit`, `cursor` → `nextCursor`); `iterate…` walks every page.

## Configuration

| Option           | Default                                              | Meaning                                                    |
| ---------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `apiKey`         | `AUVRYN_API_KEY`                                     | The API key (required)                                     |
| `baseUrl`        | `AUVRYN_API_URL`, then `https://api.auvrynspace.com` | The API origin (the SDK adds `/api/v1`)                    |
| `organizationId` | resolved once from the key                           | Skips that lookup                                          |
| `timeoutMs`      | 30 000                                               | Per JSON request (uploads and waits have their own bounds) |
| `userAgent`      | —                                                    | Prepended to the SDK's `User-Agent`                        |

## Errors

Every failure is an `AuvrynError` with a stable `code`, and for API errors the HTTP `status` and
the `requestId` to quote to support. Subclasses: `AuthenticationError` (401), `PermissionError`
(403: role or scope), `EntitlementError` (403: a workspace capability), `NotFoundError` (404),
`ConflictError` (409), `LimitReachedError` (409: a workspace limit — projects, models, concurrent runs or daily sample runs), `ValidationError` (400/422),
`RateLimitError` (429, with `retryAfterSeconds`), `ApiError` (any other status), `ConnectionError`
(network) and `WaitTimeoutError` (a `wait` reached its timeout).

```ts
import { LimitReachedError, RateLimitError } from '@auvryn/sdk';

try {
  await auvryn.executions.createSample({ projectId });
} catch (error) {
  if (error instanceof LimitReachedError) console.error('Daily sample runs used up.');
  else if (error instanceof RateLimitError) console.error(`Retry in ${error.retryAfterSeconds} s.`);
  else throw error;
}
```

## Idempotency and retries

- Creates accept `idempotencyKey` (sent as `Idempotency-Key`): the same key and request return the
  same resource for 24 hours and never create a second one. Generate one per logical operation with
  `Auvryn.idempotencyKey()` and reuse it when you retry.
- The SDK retries **only** when it is safe: reads, and creates that carry an idempotency key, after a
  connection error or a `502`/`503`/`504`, at most twice. A create without a key is never repeated.
- A `429` is never retried automatically: the error tells you when to retry.

## Waiting

| Method                     | Final states                       | Default timeout | Default interval |
| -------------------------- | ---------------------------------- | --------------- | ---------------- |
| `models.waitForValidation` | `valid`, `invalid`, `failed`       | 5 min           | 2 s              |
| `sandbox.wait`             | `completed`, `failed`              | 10 min          | 2 s              |
| `executions.wait`          | `completed`, `failed`, `cancelled` | 30 min          | 3 s              |

Pass `timeoutMs`, `intervalMs` or `signal` to change them. A timeout throws `WaitTimeoutError`
carrying the last value seen.

## Privacy

The SDK sends nothing except your API calls: no analytics, no telemetry of its own.

## Versioning

Semantic Versioning, 0.x: until 1.0, a minor version may include breaking changes (they are listed
in the release notes); patch versions never do. The SDK targets the Developer API v1, whose changes
are additive.

## License

Apache-2.0. API reference: [OpenAPI 3.1](https://api.auvrynspace.com/api/v1/openapi.json).
