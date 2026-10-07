import { z } from 'zod';

import { resolveReadableFile } from '../files.js';
import { idempotencyKeyFor as key } from '../idempotency.js';
import {
  geometry,
  idempotencyKey,
  modelId,
  projectId,
  resource,
  versionId,
  areaId,
} from '../schemas.js';
import { type AnyToolSpec, defineTool } from '../tool.js';

/*
 * Safe writes: they create Auvryn records and start Auvryn-side checks
 * (validation, sandbox) but never use execution infrastructure. Every create
 * takes an optional idempotency key; when omitted, one is generated for this
 * tool call (so the SDK may retry the call safely) and returned.
 */

const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const writeTools: readonly AnyToolSpec[] = [
  defineTool({
    name: 'create_model',
    title: 'Create model',
    description:
      'Registers a model in a project. Next: upload_model_version with its ONNX file. Side effect: creates a model record (not deleted by any tool). Returns { model, idempotencyKey }.',
    safety: 'write',
    scope: 'models:write',
    annotations: CREATE,
    input: z.object({
      projectId,
      name: z.string().min(1).max(200).describe('Model name.'),
      description: z.string().max(2000).optional().describe('Optional description.'),
      idempotencyKey,
    }),
    output: z.object({ model: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, signal }) => {
      const used = key(args.idempotencyKey);
      const model = await auvryn.models.create({
        projectId: args.projectId,
        name: args.name,
        ...(args.description === undefined ? {} : { description: args.description }),
        idempotencyKey: used,
        signal,
      });
      return { model, idempotencyKey: used };
    },
  }),

  defineTool({
    name: 'upload_model_version',
    title: 'Upload model version',
    description:
      'Creates the next version of a model and uploads its ONNX file from this machine (size and SHA-256 are computed; the file goes straight to Auvryn storage and is verified). Precondition: local file access enabled (AUVRYN_MCP_FILE_ROOT) and the file inside that root; filePath is relative to the root. The path is checked before anything is created. It does not validate: call validate_model_version next. Returns { version, artifact, idempotencyKey }.',
    safety: 'write',
    scope: 'models:write',
    annotations: CREATE,
    input: z.object({
      projectId,
      modelId,
      filePath: z
        .string()
        .min(1)
        .max(1024)
        .describe(
          'Path of the .onnx file, relative to AUVRYN_MCP_FILE_ROOT (or absolute inside it).',
        ),
      framework: z
        .enum(['pytorch', 'tensorflow', 'scikit-learn', 'custom', 'unknown'])
        .optional()
        .describe('Framework the model was exported from.'),
      description: z.string().max(2000).optional(),
      idempotencyKey,
    }),
    output: z.object({ version: resource, artifact: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, config, signal }) => {
      // The file boundary first: nothing is created for a refused path.
      const file = await resolveReadableFile(config.fileRoot, args.filePath);
      const used = key(args.idempotencyKey);
      const { version, artifact } = await auvryn.models.uploadVersion({
        projectId: args.projectId,
        modelId: args.modelId,
        file,
        ...(args.framework === undefined ? {} : { framework: args.framework }),
        ...(args.description === undefined ? {} : { description: args.description }),
        idempotencyKey: used,
        signal,
      });
      return { version, artifact, idempotencyKey: used };
    },
  }),

  defineTool({
    name: 'validate_model_version',
    title: 'Validate model version',
    description:
      "Requests validation of an uploaded model file with the official ONNX checker (asynchronous). Precondition: the version's artifact is uploaded. Safe to repeat (one validation per file; a failed one is retried). Next: wait_for_validation. Returns { validation } (status pending, running, valid, invalid or failed).",
    safety: 'write',
    scope: 'models:write',
    annotations: { ...CREATE, idempotentHint: true },
    input: z.object({ projectId, modelId, versionId }),
    output: z.object({ validation: resource }),
    run: async (args, { auvryn, signal }) => ({
      validation: await auvryn.models.validate({ ...args, signal }),
    }),
  }),

  defineTool({
    name: 'run_sample_workload',
    title: 'Run sample workload (simulated)',
    description:
      "Runs Auvryn's sample model on the Sample Environment: a SIMULATED execution (no model runs on real hardware; its provenance says simulated: true). It names no model and no provider, and never runs the user's own models. Needs the workspace's sample-workload capability and counts toward the daily sample-run limit; it has no external cost. Asynchronous: next wait_for_execution, then get_result and get_execution (provenance and telemetry). Side effect: creates an execution job. Returns { execution, idempotencyKey }.",
    safety: 'write',
    scope: 'executions:write',
    annotations: CREATE,
    input: z.object({ projectId, idempotencyKey }),
    output: z.object({ execution: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, signal }) => {
      const used = key(args.idempotencyKey);
      const execution = await auvryn.executions.createSample({
        projectId: args.projectId,
        idempotencyKey: used,
        signal,
      });
      return { execution, idempotencyKey: used };
    },
  }),

  defineTool({
    name: 'run_sandbox_test',
    title: 'Run sandbox test',
    description:
      "Runs a validated model version once in Auvryn's isolated sandbox (ONNX Runtime) with generated inputs, to check that it executes. Precondition: validation is valid (else MODEL_NOT_VALIDATED). Uses no execution provider and has no external cost. Asynchronous: next wait_for_sandbox. Returns { sandboxRun, idempotencyKey }.",
    safety: 'write',
    scope: 'models:write',
    annotations: CREATE,
    input: z.object({ projectId, modelId, versionId, idempotencyKey }),
    output: z.object({ sandboxRun: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, signal }) => {
      const used = key(args.idempotencyKey);
      const sandboxRun = await auvryn.sandbox.run({
        projectId: args.projectId,
        modelId: args.modelId,
        versionId: args.versionId,
        idempotencyKey: used,
        signal,
      });
      return { sandboxRun, idempotencyKey: used };
    },
  }),

  defineTool({
    name: 'create_area',
    title: 'Create area of interest',
    description:
      'Creates an area of interest from a GeoJSON Polygon or MultiPolygon (longitude/latitude). Auvryn validates the geometry (INVALID_AOI_GEOMETRY, AOI_TOO_LARGE) and computes its area. Returns { area, idempotencyKey }.',
    safety: 'write',
    scope: 'areas:write',
    annotations: CREATE,
    input: z.object({
      projectId,
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      geometry,
      idempotencyKey,
    }),
    output: z.object({ area: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, signal }) => {
      const used = key(args.idempotencyKey);
      const area = await auvryn.areas.create({
        projectId: args.projectId,
        name: args.name,
        geometry: args.geometry,
        ...(args.description === undefined ? {} : { description: args.description }),
        idempotencyKey: used,
        signal,
      });
      return { area, idempotencyKey: used };
    },
  }),

  defineTool({
    name: 'create_estimate',
    title: 'Create cost estimate',
    description:
      'Asks a provider for a price quote to run a validated model version, optionally over an area of interest. This is the recommended step BEFORE run_execution: it starts nothing and costs nothing; it stores an immutable estimate (amountMinor + currency, breakdown, assumptions, expiry). Get providerId from list_providers. Review the estimate (and show it to the person) before running it. Returns { estimate, idempotencyKey }.',
    safety: 'write',
    scope: 'estimates:write',
    // Asks an external provider for a quote.
    annotations: { ...CREATE, openWorldHint: true },
    input: z.object({
      projectId,
      modelVersionId: versionId,
      providerId: z.string().min(1).max(100).describe('A provider ID from list_providers.'),
      areaOfInterestId: areaId.optional(),
      idempotencyKey,
    }),
    output: z.object({ estimate: resource, idempotencyKey: z.string() }),
    run: async (args, { auvryn, signal }) => {
      const used = key(args.idempotencyKey);
      const estimate = await auvryn.estimates.create({
        projectId: args.projectId,
        modelVersionId: args.modelVersionId,
        providerId: args.providerId,
        ...(args.areaOfInterestId === undefined ? {} : { areaOfInterestId: args.areaOfInterestId }),
        idempotencyKey: used,
        signal,
      });
      return { estimate, idempotencyKey: used };
    },
  }),
];
