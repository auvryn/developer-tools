# @auvryn/mcp

`auvryn-mcp`: the official [Model Context Protocol](https://modelcontextprotocol.io) server for
[Auvryn](https://auvrynspace.com). Agents operate through the same authenticated and permissioned
Developer API boundaries as the SDK and the CLI: an API key, its workspace, its scopes, the
workspace's capabilities and limits. Built on [`@auvryn/sdk`](https://www.npmjs.com/package/@auvryn/sdk).

- Transport: stdio (the client starts the server as a local process).
- Node.js 24 or later. Version 0.x (see [Versioning](#versioning)).

## Run

```bash
npx -y @auvryn/mcp
```

It speaks MCP on stdin/stdout and logs only to stderr. It needs `AUVRYN_API_KEY` in its
environment; your MCP client passes it.

## Configure your client

Create an API key in the Auvryn web app (**Workspace → Developer → API keys**) with only the scopes
the agent needs. Never paste it into a chat; put it in the client's configuration.

**Claude Code:**

```bash
claude mcp add --transport stdio --env AUVRYN_API_KEY=auv_… auvryn -- npx -y @auvryn/mcp
```

**Claude Desktop** — `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart the app:

```json
{
  "mcpServers": {
    "auvryn": {
      "command": "npx",
      "args": ["-y", "@auvryn/mcp"],
      "env": {
        "AUVRYN_API_KEY": "auv_…"
      }
    }
  }
}
```

Any MCP client that starts stdio servers works the same way: command `npx`, arguments
`-y @auvryn/mcp`, and the environment below.

## Environment

| Variable                       | Default                       | Meaning                                                                                               |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `AUVRYN_API_KEY`               | — (required)                  | The API key: its workspace and scopes bound everything the agent can do                               |
| `AUVRYN_API_URL`               | `https://api.auvrynspace.com` | The Auvryn API                                                                                        |
| `AUVRYN_MCP_READ_ONLY`         | `false`                       | `true` refuses every tool that changes anything                                                       |
| `AUVRYN_MCP_EXECUTION_ENABLED` | `false`                       | `true` allows `run_execution` and `cancel_execution` (they may use execution infrastructure and cost) |
| `AUVRYN_MCP_FILE_ROOT`         | — (no file access)            | The only directory model uploads may read from and result downloads may write to (an absolute path)   |

## What an agent can do

31 tools, each with a safety class (also published as MCP annotations and `_meta`):

| Class              | Tools                                                                                                                                         | Gate                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **READ**           | sessions, projects, providers, models and versions, sandbox runs, areas, estimates, executions, results, usage, and the waits                 | —                                              |
| **WRITE**          | `create_model`, `upload_model_version`, `validate_model_version`, `run_sample_workload`, `run_sandbox_test`, `create_area`, `create_estimate` | refused by `AUVRYN_MCP_READ_ONLY`              |
| **COST-SENSITIVE** | `run_execution`, `cancel_execution`                                                                                                           | off unless `AUVRYN_MCP_EXECUTION_ENABLED=true` |
| **LOCAL FILE**     | `download_result_artifact` (writes a file)                                                                                                    | only inside `AUVRYN_MCP_FILE_ROOT`             |

- `run_sample_workload` runs Auvryn's sample model on the Sample Environment. It is a **write**
  (it creates an execution job) with no external cost, and the execution is **simulated**: no model
  runs on real hardware, and its provenance says `simulated: true`.
- Destructive tools: `cancel_execution` (asks the provider to stop running work) and
  `download_result_artifact` when called with `overwrite: true` (replaces a local file).
- Resources: `auvryn://session`, `auvryn://projects`, and per project its models, areas,
  executions, an execution's result and usage. Prompts: `prepare-workload`, `inspect-execution`,
  `analyze-result`.

## What it cannot do

It calls only the public Developer API, so it cannot:

- reach another workspace than the key's, or a project the key is restricted from;
- act beyond the key's scopes or its creator's current role;
- grant capabilities, raise limits or enable providers;
- see or use providers the workspace was not granted (they do not exist for it);
- read secrets, other API keys or the database;
- read or write files outside `AUVRYN_MCP_FILE_ROOT`.

Every refusal comes back as a tool error with the API's code (for example
`INSUFFICIENT_SCOPE`, `ENTITLEMENT_REQUIRED`, `SAMPLE_RUN_LIMIT_REACHED`) and request ID.

## Idempotency and limits

- Every create accepts `idempotencyKey`. When omitted, the server generates one for that call and
  returns it: reuse it if you retry, and nothing is created twice.
- Rate limits and workspace limits are the API's. A `429` is returned as an error with its retry
  time; the server never retries it silently.

## Versioning

Semantic Versioning, 0.x: until 1.0, a minor version may rename or reshape tools (listed in the
release notes); patch versions never do.

## License

Apache-2.0.
