import { WaitTimeoutError } from '@auvryn/sdk';
import { z } from 'zod';

import { idempotencyKeyFor } from '../idempotency.js';
import {
  estimateId,
  idempotencyKey,
  jobId,
  modelId,
  projectId,
  resource,
  sandboxRunId,
  timeoutSeconds,
  versionId,
} from '../schemas.js';
import { type AnyToolSpec, defineTool } from '../tool.js';

/*
 * Execution (cost-sensitive, gated) and the bounded wait tools. Nothing here
 * waits unless asked, and no wait outlives its timeout (max 120 s per call):
 * a long-running execution is followed by calling wait_for_execution again.
 */

const READ = { readOnlyHint: true, openWorldHint: false } as const;

/** A wait that returns `{ finished: false, <last state> }` at its timeout instead of failing. */
async function bounded<T>(wait: () => Promise<T>): Promise<{ finished: boolean; value: T }> {
  try {
    return { finished: true, value: await wait() };
  } catch (error) {
    if (error instanceof WaitTimeoutError && error.last !== undefined) {
      return { finished: false, value: error.last as T };
    }
    throw error;
  }
}

export const executionTools: readonly AnyToolSpec[] = [
  defineTool({
    name: 'run_execution',
    title: 'Run execution from estimate',
    description:
      'Creates an execution job from an existing cost estimate (create_estimate first; the estimate fixes the model version, provider and area). This may use external execution infrastructure and cause cost. It returns immediately with the job (status created/queued); it does not wait — use wait_for_execution or get_execution. Not reversible once the provider runs it (cancel_execution only requests a stop). Pass an idempotencyKey and reuse it when retrying: the same key returns the same job and never starts a second execution. If omitted, one is generated for this call and returned — reuse it if you retry. Returns { execution, idempotencyKey }.',
    safety: 'cost-sensitive',
    scope: 'executions:write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    input: z.object({ projectId, costEstimateId: estimateId, idempotencyKey }),
    output: z.object({ execution: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, signal }) => {
      const used = idempotencyKeyFor(args.idempotencyKey);
      const execution = await auvryn.executions.create({
        projectId: args.projectId,
        costEstimateId: args.costEstimateId,
        idempotencyKey: used,
        signal,
      });
      return { execution, idempotencyKey: used };
    },
  }),

  defineTool({
    name: 'cancel_execution',
    title: 'Cancel execution',
    description:
      'Requests cancellation of an active execution. It affects running work on the provider and cannot be undone: the job ends cancelled (or completes/fails if the provider finishes first). Gated like run_execution. Returns { execution } with cancellationRequested.',
    safety: 'cost-sensitive',
    scope: 'executions:write',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    input: z.object({ projectId, jobId }),
    output: z.object({ execution: resource }),
    run: async (args, { auvryn, signal }) => ({
      execution: await auvryn.executions.cancel({ ...args, signal }),
    }),
  }),

  defineTool({
    name: 'wait_for_validation',
    title: 'Wait for validation',
    description:
      'Waits (at most timeoutSeconds, default 30, max 120) until a validation is valid, invalid or failed. Returns { finished, validation }; finished=false means it is still running — call again.',
    safety: 'read',
    scope: 'models:read',
    annotations: READ,
    input: z.object({ projectId, modelId, versionId, timeoutSeconds }),
    output: z.object({ finished: z.boolean(), validation: resource }),
    run: async ({ timeoutSeconds: seconds, ...ref }, { auvryn, signal }) => {
      const { finished, value } = await bounded(() =>
        auvryn.models.waitForValidation({
          ...ref,
          timeoutMs: seconds * 1000,
          intervalMs: 1000,
          signal,
        }),
      );
      return { finished, validation: value };
    },
  }),

  defineTool({
    name: 'wait_for_sandbox',
    title: 'Wait for sandbox run',
    description:
      'Waits (at most timeoutSeconds, default 30, max 120) until a sandbox run is completed or failed. Returns { finished, sandboxRun }; finished=false means it is still running — call again.',
    safety: 'read',
    scope: 'models:read',
    annotations: READ,
    input: z.object({ projectId, modelId, versionId, sandboxRunId, timeoutSeconds }),
    output: z.object({ finished: z.boolean(), sandboxRun: resource }),
    run: async ({ timeoutSeconds: seconds, ...ref }, { auvryn, signal }) => {
      const { finished, value } = await bounded(() =>
        auvryn.sandbox.wait({ ...ref, timeoutMs: seconds * 1000, intervalMs: 1000, signal }),
      );
      return { finished, sandboxRun: value };
    },
  }),

  defineTool({
    name: 'wait_for_execution',
    title: 'Wait for execution',
    description:
      'Waits (at most timeoutSeconds, default 30, max 120) until an execution is completed, failed or cancelled. Real executions can take hours: finished=false means it is still running — call again later or use get_execution. Returns { finished, execution }.',
    safety: 'read',
    scope: 'executions:read',
    annotations: READ,
    input: z.object({ projectId, jobId, timeoutSeconds }),
    output: z.object({ finished: z.boolean(), execution: resource }),
    run: async ({ timeoutSeconds: seconds, ...ref }, { auvryn, signal }) => {
      const { finished, value } = await bounded(() =>
        auvryn.executions.wait({ ...ref, timeoutMs: seconds * 1000, intervalMs: 1000, signal }),
      );
      return { finished, execution: value };
    },
  }),
];
