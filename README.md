# Auvryn developer tools

The official developer interfaces for [Auvryn](https://auvrynspace.com), provider-neutral
execution infrastructure for AI models: validate ONNX models, run them as durable ExecutionJobs and
read verified results with provenance and telemetry.

> **Status:** the first release, 0.1.0, is being prepared. The packages are not on npm yet; until
> they are, the REST API below is the public interface.

| Package                       | What it is                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| [`@auvryn/sdk`](packages/sdk) | TypeScript SDK for the Developer API (Node.js 24+)         |
| [`@auvryn/cli`](packages/cli) | `auvryn`, the command line (terminals and CI)              |
| [`@auvryn/mcp`](packages/mcp) | `auvryn-mcp`, the Model Context Protocol server for agents |

All three use the same public REST API, `https://api.auvrynspace.com`
([OpenAPI 3.1](https://api.auvrynspace.com/api/v1/openapi.json)), with an API key created in the
Auvryn web app (**Workspace → Developer → API keys**).

## Start

[examples/typescript/basic-execution](examples/typescript/basic-execution) runs Auvryn's sample
model on the Sample Environment — a **simulated** execution, labelled as such — and reads its
result, provenance and telemetry.

## What is available

- **Interfaces:** the REST API is public; the SDK, the CLI and the MCP server are published from
  this repository.
- **Execution environments:** the Sample Environment is available to every workspace and is
  **simulated**: no model runs on real hardware. Real execution environments are not offered
  publicly: a workspace sees and uses only the providers it was granted (`GET /api/v1/providers`
  lists exactly those; any other provider does not exist for it).

## Current limitations

- Node.js 24 or later; ES modules only (no CommonJS build).
- Your own models can be uploaded, validated and tested in Auvryn's isolated sandbox; running them
  needs a provider your workspace was granted.
- The Sample Environment allows a few runs per workspace per day.
- No hosted MCP endpoint: the MCP server runs locally over stdio.

## Versioning

Semantic Versioning. Until 1.0, a minor version may include breaking changes (listed in the release
notes); patch versions never do. The packages target the Developer API v1, whose changes are
additive.

## Releases

Every package is published from this repository by GitHub Actions with npm Trusted Publishing (no
long-lived token) and npm provenance, which links each version to the commit and the workflow run
that built it. The workflow tests the exact tarball it publishes. Verify an installed version with
`npm audit signatures`.

## Security and contributing

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
