# MCP tools

31 tools. Every tool:

- takes an object input with strict schemas (public IDs only: `prj_…`, `mdl_…`, `mdlver_…`,
  `aoi_…`, `est_…`, `job_…`, `rart_…`, `sbox_…`; UUIDs are rejected);
- returns `structuredContent` (an object, validated against its `outputSchema`) and the same JSON as
  text;
- declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
  and its safety class and scope in `_meta` (`auvryn/safety`, `auvryn/scope`) and its description.

Safety classes:

| Class              | Meaning                                                                                   | Gate                                           |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **READ**           | No side effects                                                                           | —                                              |
| **WRITE**          | Creates Auvryn records or starts Auvryn-side checks; no execution infrastructure, no cost | `AUVRYN_MCP_READ_ONLY` refuses                 |
| **COST-SENSITIVE** | Starts or stops work on execution infrastructure; may cause cost                          | Off unless `AUVRYN_MCP_EXECUTION_ENABLED=true` |
| **LOCAL FILE**     | Writes a file on this machine                                                             | Only inside `AUVRYN_MCP_FILE_ROOT`             |

`upload_model_version` is WRITE and also reads a local file, so it also needs the file root.
Scopes are enforced by Auvryn, not the server: a key without the scope gets `INSUFFICIENT_SCOPE`.

## Read

| Tool                       | Scope                     | Inputs                                                                     | Returns                                                                                                         |
| -------------------------- | ------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `get_session_info`         | —                         | —                                                                          | `server` (versions), `apiKey` (public ID, org, project, scopes), `gates`                                        |
| `list_projects`            | `projects:read`           | —                                                                          | `projects`                                                                                                      |
| `get_project`              | `projects:read`           | `projectId`                                                                | `project`                                                                                                       |
| `get_project_capabilities` | `models:read, areas:read` | `projectId`                                                                | `providers`, `readyModelVersions`, `models` (≤20, ≤10 versions each), `areas` (≤20), `more`, `executionEnabled` |
| `list_providers`           | —                         | —                                                                          | `providers` (as the API reports them; never assume an ID)                                                       |
| `list_models`              | `models:read`             | `projectId`, `limit` (≤100, default 20), `cursor`                          | `models`, `nextCursor`                                                                                          |
| `get_model`                | `models:read`             | `projectId`, `modelId`                                                     | `model`, `versions` (with readiness)                                                                            |
| `get_model_version`        | `models:read`             | `projectId`, `modelId`, `versionId`                                        | `version`, `validation` (or null), `sandboxRuns` (≤10)                                                          |
| `get_sandbox_run`          | `models:read`             | `projectId`, `modelId`, `versionId`, `sandboxRunId`                        | `sandboxRun`                                                                                                    |
| `list_areas`               | `areas:read`              | `projectId`, `limit`, `cursor`                                             | `areas` (summaries, no geometry), `nextCursor`                                                                  |
| `get_area`                 | `areas:read`              | `projectId`, `areaId`                                                      | `area` (with geometry)                                                                                          |
| `list_estimates`           | `estimates:read`          | `projectId`, `limit`, `cursor`                                             | `estimates`, `nextCursor`                                                                                       |
| `get_estimate`             | `estimates:read`          | `projectId`, `estimateId`                                                  | `estimate` (amountMinor + currency, breakdown, assumptions, expiry)                                             |
| `list_executions`          | `executions:read`         | `projectId`, `status[]`, `providerId`, `modelVersionId`, `limit`, `cursor` | `executions`, `nextCursor`                                                                                      |
| `get_execution`            | `executions:read`         | `projectId`, `jobId`                                                       | `execution`                                                                                                     |
| `get_usage`                | `usage:read`              | `projectId`, `executionJobId?`, `limit`                                    | `usage` (totals, events, nextCursor), `ledger` (totals, entries, nextCursor) — not billing                      |
| `wait_for_validation`      | `models:read`             | `projectId`, `modelId`, `versionId`, `timeoutSeconds` (1–120, default 30)  | `finished`, `validation`                                                                                        |
| `wait_for_sandbox`         | `models:read`             | `projectId`, `modelId`, `versionId`, `sandboxRunId`, `timeoutSeconds`      | `finished`, `sandboxRun`                                                                                        |
| `wait_for_execution`       | `executions:read`         | `projectId`, `jobId`, `timeoutSeconds`                                     | `finished`, `execution` (call again while `finished` is false)                                                  |
| `get_result`               | `results:read`            | `projectId`, `jobId`                                                       | `result` (provenance, summary), `artifacts` (metadata + `previewable`)                                          |
| `preview_result_artifact`  | `results:read`            | `projectId`, `jobId`, `artifactId`, `maxBytes` (≤65536, default 16384)     | `artifact`, `preview` (UTF-8), `previewBytes`, `truncated` (text types only)                                    |

## Write

| Tool                     | Scope              | Side effects                                                                                                         | Inputs                                                                                            | Returns                                 |
| ------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `create_model`           | `models:write`     | Creates a model                                                                                                      | `projectId`, `name`, `description?`, `idempotencyKey?`                                            | `model`, `idempotencyKey`               |
| `upload_model_version`   | `models:write`     | Reads a local file (inside the file root); creates a version; uploads the file                                       | `projectId`, `modelId`, `filePath`, `framework?`, `description?`, `idempotencyKey?`               | `version`, `artifact`, `idempotencyKey` |
| `validate_model_version` | `models:write`     | Starts validation (idempotent per file)                                                                              | `projectId`, `modelId`, `versionId`                                                               | `validation`                            |
| `run_sample_workload`    | `executions:write` | Starts Auvryn's sample model on the Sample Environment: **simulated**, no cost; needs `sample-workload`; daily limit | `projectId`, `idempotencyKey?`                                                                    | `execution`, `idempotencyKey`           |
| `run_sandbox_test`       | `models:write`     | Starts a sandbox run (Auvryn's own sandbox; no provider, no cost)                                                    | `projectId`, `modelId`, `versionId`, `idempotencyKey?`                                            | `sandboxRun`, `idempotencyKey`          |
| `create_area`            | `areas:write`      | Creates an area of interest                                                                                          | `projectId`, `name`, `description?`, `geometry` (GeoJSON Polygon/MultiPolygon), `idempotencyKey?` | `area`, `idempotencyKey`                |
| `create_estimate`        | `estimates:write`  | Asks a provider for a quote; stores an immutable estimate; starts nothing, costs nothing                             | `projectId`, `modelVersionId`, `providerId`, `areaOfInterestId?`, `idempotencyKey?`               | `estimate`, `idempotencyKey`            |

None of these is reversible through MCP (no delete tools), and none uses execution infrastructure.

## Cost-sensitive (gated)

| Tool               | Scope              | Side effects                                                                                                              | Inputs                                           | Returns                       |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------- |
| `run_execution`    | `executions:write` | Creates an execution from a cost estimate; uses external infrastructure; may cost money; returns immediately (no waiting) | `projectId`, `costEstimateId`, `idempotencyKey?` | `execution`, `idempotencyKey` |
| `cancel_execution` | `executions:write` | Requests cancellation of running work; irreversible                                                                       | `projectId`, `jobId`                             | `execution`                   |

Both are refused with `EXECUTION_DISABLED`, before any request, unless the server runs with
`AUVRYN_MCP_EXECUTION_ENABLED=true`. Executions start only from an existing estimate (the
estimate fixes model version, provider and area): create and review the estimate first.

## Local file

| Tool                       | Scope          | Side effects                                                                                                   | Inputs                                                                             | Returns                                     |
| -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| `download_result_artifact` | `results:read` | Writes one file inside the file root (streamed, SHA-256 verified); replaces a file only with `overwrite: true` | `projectId`, `jobId`, `artifactId`, `destinationPath`, `overwrite` (default false) | `path`, `sizeBytes`, `sha256`, `artifactId` |

## Idempotency

Every create (`create_model`, `upload_model_version`, `run_sample_workload`, `run_sandbox_test`, `create_area`,
`create_estimate`, `run_execution`) accepts `idempotencyKey`:

- **Given:** sent to Auvryn as is; the same key and request return the same resource for 24 hours —
  from any client, including a restarted MCP server.
- **Omitted:** the server generates one for **this invocation only** (`mcp_` + 144 random bits), uses
  it for every SDK retry of that invocation, and returns it. A new invocation gets a new key.
- To retry a call whose response was lost (e.g. the client timed out), call again **with the
  returned or your own key** — never without it, or a second resource (or execution) may be created.

The server itself never retries writes beyond the SDK's guarantees (only creates that carry a key,
only on connection errors and `502`/`503`/`504`).
