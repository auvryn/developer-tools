# @auvryn/cli

`auvryn`: the official command line for the [Auvryn](https://auvrynspace.com) Developer API (v1).
Validate ONNX models, run ExecutionJobs and read their results, provenance and telemetry from a
terminal or CI. Built on [`@auvryn/sdk`](https://www.npmjs.com/package/@auvryn/sdk).

- Node.js 24 or later; macOS, Linux and Windows (PowerShell, cmd, Git Bash).
- Version 0.x: minor versions may change commands (see [Versioning](#versioning)).

## Install

```bash
npm install --global @auvryn/cli
auvryn --version
```

Or without installing: `npx @auvryn/cli --help`.

## Configure

The CLI reads the API key from the environment only — never from a flag, so it never appears in
your shell history or process list. Create a key in the Auvryn web app (**Workspace → Developer →
API keys**); the secret is shown once.

```bash
export AUVRYN_API_KEY="auv_…"       # required
export AUVRYN_PROJECT_ID="prj_…"    # default project (or --project)
```

On Windows PowerShell: `$env:AUVRYN_API_KEY = "auv_…"`.

| Setting | Flag                    | Environment         | Default                       |
| ------- | ----------------------- | ------------------- | ----------------------------- |
| API key | —                       | `AUVRYN_API_KEY`    | — (required)                  |
| Project | `-p, --project <id>`    | `AUVRYN_PROJECT_ID` | —                             |
| API URL | `--api-url <url>`       | `AUVRYN_API_URL`    | `https://api.auvrynspace.com` |
| Output  | `--json`, `-q, --quiet` | —                   | human-readable                |

The CLI stores nothing on disk: no config file, no credentials cache.

## Quickstart

Every workspace can run Auvryn's sample model on the **Sample Environment**. That execution is
**simulated**: no model runs on real hardware.

```bash
auvryn auth status                     # the key's workspace, project restriction and scopes
auvryn executions sample --wait        # start the sample and wait for it
auvryn executions get job_…            # status, environment, simulated: yes, telemetry
auvryn results get job_…               # the stored result and its artifacts
auvryn results download job_… -o ./out # artifacts, SHA-256 verified
```

Your own model:

```bash
auvryn models create --name "My detector"
auvryn models upload mdl_… --file ./model.onnx
auvryn models validate mdl_… mdlver_… --wait
auvryn sandbox run mdl_… mdlver_… --wait   # optional: one isolated test run, nothing billed
auvryn providers list                       # the providers your workspace can use
```

Running your own model needs a provider listed for your workspace; Auvryn never picks one for you.

## Commands

| Group        | Commands                                                                |
| ------------ | ----------------------------------------------------------------------- |
| `auth`       | `status`                                                                |
| `projects`   | `list`, `get`                                                           |
| `providers`  | `list`                                                                  |
| `models`     | `list`, `get`, `create`, `versions`, `upload`, `validate`, `validation` |
| `sandbox`    | `run`, `get`, `wait`                                                    |
| `areas`      | `list`, `get`, `create` (GeoJSON file)                                  |
| `estimates`  | `list`, `get`, `create`                                                 |
| `executions` | `list`, `get`, `run`, `sample` (simulated), `wait`, `cancel`            |
| `results`    | `get`, `download`                                                       |
| `usage`      | `list`, `ledger` (usage and provider cost estimates; not billing)       |

`auvryn <group> <command> --help` documents every option. Creates accept `--idempotency-key`:
reuse the same key when you retry and nothing is created twice.

## Output and exit codes

- stdout carries only the result: a table by default, JSON with `--json`.
- stderr carries progress and errors (`--quiet` silences progress).

| Exit | Meaning                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 0    | Success                                                                                                       |
| 1    | API or network error, or a wait that timed out (code, status and request ID are printed)                      |
| 2    | Usage or configuration error (no request was sent)                                                            |
| 3    | Finished unsuccessfully: an execution failed or was cancelled, a validation was invalid, a sandbox run failed |

## CI

```yaml
- run: npx --yes @auvryn/cli --json executions sample --wait > run.json
  env:
    AUVRYN_API_KEY: ${{ secrets.AUVRYN_API_KEY }}
    AUVRYN_PROJECT_ID: ${{ vars.AUVRYN_PROJECT_ID }}
```

Use a key with only the scopes the job needs. A `429` is reported, never retried silently.

## Versioning

Semantic Versioning, 0.x: until 1.0, a minor version may change commands or output (listed in the
release notes); patch versions never do. JSON output follows the Developer API v1.

## License

Apache-2.0.
