# Registry end-to-end checks

These scripts check the packages **as published on npm** (never this workspace) against the
production API, with a dedicated API key of a normal workspace:

| Script    | Checks                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sdk.mjs` | version, production default, authentication, only the Sample Environment, idempotent sample, wait, result, provenance, telemetry |
| `cli.mjs` | version, help, exit codes 0/1/2, JSON and human output, `executions sample --wait`, results, provenance                          |
| `mcp.mjs` | initialize, tools/list and safety classes, read-only and execution gates, providers, `run_sample_workload`, result, provenance   |

Each script also fails if the key appears in any output or if a response names a provider that is
not public. Every run uses three of the workspace's daily sample runs (one per script).

Run them with the **Registry E2E** workflow (`.github/workflows/registry-e2e.yml`), which installs
the given version from npm and reads `AUVRYN_E2E_API_KEY` (secret) and `AUVRYN_E2E_PROJECT_ID`
(variable). The key needs the scopes `executions:read`, `executions:write` and `results:read`, and
nothing else.

Locally, from this directory:

```bash
npm install --no-save @auvryn/sdk@0.1.0 @auvryn/cli@0.1.0 @auvryn/mcp@0.1.0 @modelcontextprotocol/client@2.2.0
read -rs AUVRYN_E2E_API_KEY && export AUVRYN_E2E_API_KEY   # hidden input, not in history
export AUVRYN_E2E_PROJECT_ID=prj_…
node sdk.mjs && node cli.mjs && node mcp.mjs
```
