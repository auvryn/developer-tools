import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { jobId, modelId, projectId } from './schemas.js';

/*
 * Prompts: short, reusable instructions a person can pick in their MCP client.
 * They guide inspection and preparation; none of them decides to spend money:
 * the workload prompt stops before run_execution and asks for a human review.
 */

const user = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'prepare-workload',
    {
      title: 'Prepare a workload (stop before execution)',
      description:
        'Guides an agent to get a project ready to run: a validated, sandbox-tested model version, an area and a cost estimate. It stops before run_execution.',
      argsSchema: z.object({ projectId, modelId: modelId.optional() }),
    },
    ({ projectId: project, modelId: model }) =>
      user(
        [
          `Prepare a workload in Auvryn project ${project}${model ? ` for model ${model}` : ''}.`,
          '',
          "1. Call get_session_info to learn your scopes and this server's gates.",
          `2. Call get_project_capabilities for ${project}: providers, ready model versions, areas.`,
          '3. If no version is ready: upload_model_version (if a file is available), then validate_model_version and wait_for_validation. If validation is invalid, report the reason and stop.',
          '4. Run run_sandbox_test on the ready version and wait_for_sandbox; report the outcome.',
          '5. Pick an existing area (or create_area if the person gave a geometry).',
          '6. create_estimate with a provider from list_providers (never assume a provider ID).',
          '7. STOP. Do not call run_execution. Summarize the version, sandbox result, area and the estimate (amount, currency, provider, expiry) and ask the person to review and approve it.',
          '',
          'The workload is ready only when the person has reviewed the estimate.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'inspect-execution',
    {
      title: 'Inspect an execution',
      description:
        'Explains the state of an execution job: status, provider, estimate, failure reason and next steps.',
      argsSchema: z.object({ projectId, jobId }),
    },
    ({ projectId: project, jobId: job }) =>
      user(
        [
          `Inspect execution ${job} in project ${project}.`,
          '',
          '1. get_execution: report status, provider, the estimate it ran from and timestamps.',
          '2. If it failed: explain failure.code and failure.message; do not retry automatically.',
          '3. If it is still running: say so; wait_for_execution only if asked (it returns after at most its timeout).',
          '4. If it completed: get_result and summarize the artifacts (names, kinds, sizes).',
          'Do not cancel or re-run anything.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'analyze-result',
    {
      title: 'Analyze a result',
      description:
        'Summarizes the result of a completed execution and its usage, previewing small text artifacts only.',
      argsSchema: z.object({ projectId, jobId }),
    },
    ({ projectId: project, jobId: job }) =>
      user(
        [
          `Analyze the result of execution ${job} in project ${project}.`,
          '',
          '1. get_result: list the artifacts with their kind, media type and size.',
          '2. For previewable (textual) artifacts, preview_result_artifact with a small maxBytes and summarize what they contain. Never try to read binary artifacts.',
          '3. get_usage with executionJobId: report what was consumed and the provider cost estimate (it is not a bill).',
          '4. Offer download_result_artifact for artifacts the person wants locally (it needs AUVRYN_MCP_FILE_ROOT).',
        ].join('\n'),
      ),
  );
}
