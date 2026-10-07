# Auvryn developer tools

The official developer interfaces for [Auvryn](https://auvrynspace.com), provider-neutral
execution infrastructure for AI models: validate ONNX models, run them as durable ExecutionJobs and
read verified results with provenance and telemetry.

| Package                       | What it is                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| [`@auvryn/sdk`](packages/sdk) | TypeScript SDK for the Developer API (Node.js 24+)         |
| [`@auvryn/cli`](packages/cli) | `auvryn`, the command line (terminals and CI)              |
| [`@auvryn/mcp`](packages/mcp) | `auvryn-mcp`, the Model Context Protocol server for agents |

All three use the same public REST API: <https://api.auvrynspace.com>
([OpenAPI 3.1](https://api.auvrynspace.com/api/v1/openapi.json)), with an API key created in the
Auvryn web app.

## Start

```bash
npm install @auvryn/sdk
export AUVRYN_API_KEY="auv_…" AUVRYN_PROJECT_ID="prj_…"
```

Then follow [examples/typescript/basic-execution](examples/typescript/basic-execution): it runs
Auvryn's sample model on the Sample Environment — a **simulated** execution, labelled as such — and
reads its result, provenance and telemetry.

## What is available

- **Interfaces:** the REST API, the SDK, the CLI and the MCP server are public.
- **Execution environments:** the Sample Environment is available to every workspace and is
  simulated. Real execution environments are not offered publicly yet; a workspace only ever sees
  the providers it can use (`GET /api/v1/providers`).

## Releases

Every package is published from this repository by GitHub Actions with npm Trusted Publishing
(no long-lived token) and npm provenance: the attestation links each version to the commit and the
workflow run that built it. Check it with `npm audit signatures`.

## License

[Apache-2.0](LICENSE).
