import { API_VERSION, Auvryn } from '@auvryn/sdk';
import { McpServer } from '@modelcontextprotocol/server';

import type { McpConfig } from './config.js';
import type { Logger } from './log.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { type AnyToolSpec, registerTool } from './tool.js';
import { executionTools } from './tools/execution.js';
import { readTools } from './tools/read.js';
import { resultTools } from './tools/results.js';
import { writeTools } from './tools/write.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js';

/*
 * The Auvryn MCP server: Agent → MCP → @auvryn/sdk → Developer API. It holds
 * no business logic and no workflow state: every call names its project and
 * resources explicitly, and authorization is the API key's (ADR-0026).
 */

/** Every tool, in the order clients list them. All are always listed; gates refuse at call time. */
export const TOOLS: readonly AnyToolSpec[] = [
  ...readTools,
  ...writeTools,
  ...executionTools,
  ...resultTools,
];

const INSTRUCTIONS = `Auvryn runs machine-learning models on cloud and orbital infrastructure (Developer API ${API_VERSION}).
Typical flow: get_session_info → get_project_capabilities → create_model → upload_model_version → validate_model_version → wait_for_validation → run_sandbox_test → wait_for_sandbox → create_area → create_estimate → (human review) → run_execution → wait_for_execution → get_result → get_usage.
Always create and review a cost estimate before run_execution. run_execution and cancel_execution are cost-sensitive and disabled unless the operator enabled them. Pass explicit IDs (prj_…, mdl_…, job_…) to every tool; the server keeps no current project. Errors carry a machine-readable code and a requestId.`;

export function createAuvrynServer(dependencies: {
  readonly config: McpConfig;
  readonly logger: Logger;
  /** Tests only: the SDK's fetch. */
  readonly fetch?: ((request: Request) => Promise<Response>) | undefined;
}): () => McpServer {
  const { config, logger } = dependencies;
  // One SDK client per process: the key stays in its closure (never logged or returned).
  const auvryn = new Auvryn({
    apiKey: config.apiKey,
    ...(config.apiUrl ? { baseUrl: config.apiUrl } : {}),
    userAgent: `auvryn-mcp/${MCP_SERVER_VERSION}`,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  });
  return () => {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, title: `Auvryn (API ${API_VERSION})` },
      { instructions: INSTRUCTIONS },
    );
    for (const tool of TOOLS) {
      registerTool(server, tool, { auvryn, config, logger });
    }
    registerResources(server, { auvryn, config, logger });
    registerPrompts(server);
    return server;
  };
}
