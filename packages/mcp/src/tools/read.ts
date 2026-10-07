import { API_VERSION, type ExecutionJobStatus, SDK_VERSION } from '@auvryn/sdk';
import { z } from 'zod';

import {
  areaId,
  cursor,
  estimateId,
  jobId,
  limit,
  modelId,
  page,
  projectId,
  resource,
  sandboxRunId,
  versionId,
} from '../schemas.js';
import { type AnyToolSpec, defineTool } from '../tool.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../version.js';

/*
 * Read tools: inspection only, no side effects. Lists are paged (default 20)
 * and summarize where full records would flood an agent's context.
 */

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const CAPABILITY_MODELS = 20;
const CAPABILITY_VERSIONS = 10;
const CAPABILITY_AREAS = 20;

const areaSummary = (area: {
  id: string;
  name: string;
  areaSquareMeters: number;
  createdAt: string;
}) => ({
  id: area.id,
  name: area.name,
  areaSquareMeters: area.areaSquareMeters,
  createdAt: area.createdAt,
});

export const readTools: readonly AnyToolSpec[] = [
  defineTool({
    name: 'get_session_info',
    title: 'Get session info',
    description:
      'Describes this connection: the MCP server and Auvryn API versions, the API key in use (its public ID, organization, project restriction and scopes — never the key itself), and which gated capabilities this server allows (execution, local files, read-only mode). Call it first to know what you may do.',
    safety: 'read',
    scope: null,
    annotations: READ,
    input: z.object({}),
    output: z.object({
      server: z.object({
        name: z.string(),
        version: z.string(),
        sdkVersion: z.string(),
        apiVersion: z.string(),
      }),
      apiKey: z.looseObject({}),
      gates: z.object({
        executionEnabled: z.boolean(),
        fileAccessEnabled: z.boolean(),
        readOnly: z.boolean(),
      }),
    }),
    run: async (_args, { auvryn, config, signal }) => {
      const me = await auvryn.me({ signal });
      const principal = me.principal;
      return {
        server: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
          sdkVersion: SDK_VERSION,
          apiVersion: API_VERSION,
        },
        apiKey:
          principal.kind === 'api-key'
            ? {
                id: principal.apiKeyId,
                organizationId: principal.organizationId,
                projectId: principal.projectId,
                scopes: principal.scopes,
                expiresAt: me.session.expiresAt,
              }
            : { kind: principal.kind },
        gates: {
          executionEnabled: config.executionEnabled,
          fileAccessEnabled: config.fileRoot !== undefined,
          readOnly: config.readOnly,
        },
      };
    },
  }),

  defineTool({
    name: 'list_projects',
    title: 'List projects',
    description:
      'Lists the projects this API key can reach (all of its organization, or its one restricted project). Returns { projects }.',
    safety: 'read',
    scope: 'projects:read',
    annotations: READ,
    input: z.object({}),
    output: z.object({ projects: z.array(resource) }),
    run: async (_args, { auvryn, signal }) => ({
      projects: [...(await auvryn.projects.list({ signal })).data],
    }),
  }),

  defineTool({
    name: 'get_project',
    title: 'Get project',
    description: "Returns one project. Projects outside the key's reach answer PROJECT_NOT_FOUND.",
    safety: 'read',
    scope: 'projects:read',
    annotations: READ,
    input: z.object({ projectId }),
    output: z.object({ project: resource }),
    run: async ({ projectId: id }, { auvryn, signal }) => ({
      project: await auvryn.projects.get({ projectId: id, signal }),
    }),
  }),

  defineTool({
    name: 'get_project_capabilities',
    title: 'Get project capabilities',
    description: `Summarizes what can be run in a project, in one call: the available providers (IDs to use in create_estimate), the model versions ready for estimates and executions (artifact uploaded and validation valid), the newest ${String(CAPABILITY_MODELS)} models with up to ${String(CAPABILITY_VERSIONS)} versions each, the newest ${String(CAPABILITY_AREAS)} areas of interest, and the gates of this server. Use list_* tools to page further.`,
    safety: 'read',
    scope: 'models:read, areas:read',
    annotations: READ,
    input: z.object({ projectId }),
    output: z.object({
      projectId: z.string(),
      providers: z.array(z.object({ id: z.string(), name: z.string() })),
      readyModelVersions: z.array(
        z.object({
          modelId: z.string(),
          modelName: z.string(),
          versionId: z.string(),
          version: z.number(),
        }),
      ),
      models: z.array(z.looseObject({ id: z.string() })),
      areas: z.array(z.looseObject({ id: z.string() })),
      more: z.object({ models: z.boolean(), areas: z.boolean() }),
      executionEnabled: z.boolean(),
    }),
    run: async ({ projectId: id }, { auvryn, config, signal }) => {
      const [providers, models, areas] = await Promise.all([
        auvryn.providers.list({ signal }),
        auvryn.models.list({ projectId: id, limit: CAPABILITY_MODELS, signal }),
        auvryn.areas.list({ projectId: id, limit: CAPABILITY_AREAS, signal }),
      ]);
      const withVersions = await Promise.all(
        models.data.map(async (model) => ({
          model,
          versions: (await auvryn.models.listVersions({ projectId: id, modelId: model.id, signal }))
            .data,
        })),
      );
      return {
        projectId: id,
        providers: providers.data.map((provider) => ({ id: provider.id, name: provider.name })),
        readyModelVersions: withVersions.flatMap(({ model, versions }) =>
          versions
            .filter(
              (v) => v.readiness.artifact === 'uploaded' && v.readiness.validation === 'valid',
            )
            .map((v) => ({
              modelId: model.id,
              modelName: model.name,
              versionId: v.id,
              version: v.version,
            })),
        ),
        models: withVersions.map(({ model, versions }) => ({
          id: model.id,
          name: model.name,
          versions: versions.slice(0, CAPABILITY_VERSIONS).map((v) => ({
            id: v.id,
            version: v.version,
            artifact: v.readiness.artifact,
            validation: v.readiness.validation,
          })),
        })),
        areas: areas.data.map(areaSummary),
        more: { models: models.nextCursor !== null, areas: areas.nextCursor !== null },
        executionEnabled: config.executionEnabled,
      };
    },
  }),

  defineTool({
    name: 'list_providers',
    title: 'List providers',
    description:
      'Lists the execution providers available in this Auvryn environment, as the API reports them. Use their IDs in create_estimate; never assume a provider ID.',
    safety: 'read',
    scope: null,
    annotations: READ,
    input: z.object({}),
    output: z.object({ providers: z.array(resource) }),
    run: async (_args, { auvryn, signal }) => ({
      providers: [...(await auvryn.providers.list({ signal })).data],
    }),
  }),

  defineTool({
    name: 'list_models',
    title: 'List models',
    description:
      'Lists the models of a project, newest first, one page at a time. Returns { models, nextCursor }.',
    safety: 'read',
    scope: 'models:read',
    annotations: READ,
    input: z.object({ projectId, limit, cursor }),
    output: page('models'),
    run: async (args, { auvryn, signal }) => {
      const result = await auvryn.models.list({ ...args, signal });
      return { models: [...result.data], nextCursor: result.nextCursor };
    },
  }),

  defineTool({
    name: 'get_model',
    title: 'Get model',
    description:
      'Returns a model and its versions (highest first), each with its readiness: artifact (none, pending, uploaded) and validation (none, pending, running, valid, invalid, failed).',
    safety: 'read',
    scope: 'models:read',
    annotations: READ,
    input: z.object({ projectId, modelId }),
    output: z.object({ model: resource, versions: z.array(resource) }),
    run: async (args, { auvryn, signal }) => {
      const [model, versions] = await Promise.all([
        auvryn.models.get({ ...args, signal }),
        auvryn.models.listVersions({ ...args, signal }),
      ]);
      return { model, versions: [...versions.data] };
    },
  }),

  defineTool({
    name: 'get_model_version',
    title: 'Get model version',
    description:
      'Returns a model version with its readiness, its validation (status, ONNX metadata or the rejection reason) when one was requested, and its sandbox runs. A version can be estimated and executed when its validation is valid.',
    safety: 'read',
    scope: 'models:read',
    annotations: READ,
    input: z.object({ projectId, modelId, versionId }),
    output: z.object({
      version: resource,
      validation: resource.nullable(),
      sandboxRuns: z.array(resource),
    }),
    run: async (args, { auvryn, signal }) => {
      const version = await auvryn.models.getVersion({ ...args, signal });
      const [validation, runs] = await Promise.all([
        version.readiness.validation === 'none'
          ? Promise.resolve(null)
          : auvryn.models.getValidation({ ...args, signal }),
        auvryn.sandbox.list({ ...args, signal }),
      ]);
      return { version, validation, sandboxRuns: runs.data.slice(0, 10) };
    },
  }),

  defineTool({
    name: 'get_sandbox_run',
    title: 'Get sandbox run',
    description:
      'Returns one sandbox run: status (pending, running, completed, failed), runtime, input/output summaries and metrics, or the failure reason.',
    safety: 'read',
    scope: 'models:read',
    annotations: READ,
    input: z.object({ projectId, modelId, versionId, sandboxRunId }),
    output: z.object({ sandboxRun: resource }),
    run: async (args, { auvryn, signal }) => ({
      sandboxRun: await auvryn.sandbox.get({ ...args, signal }),
    }),
  }),

  defineTool({
    name: 'list_areas',
    title: 'List areas of interest',
    description:
      'Lists the areas of interest of a project (summaries: ID, name, area in m²), newest first, one page at a time. Use get_area for a geometry.',
    safety: 'read',
    scope: 'areas:read',
    annotations: READ,
    input: z.object({ projectId, limit, cursor }),
    output: z.object({ areas: z.array(resource), nextCursor: z.string().nullable() }),
    run: async (args, { auvryn, signal }) => {
      const result = await auvryn.areas.list({ ...args, signal });
      return { areas: result.data.map(areaSummary), nextCursor: result.nextCursor };
    },
  }),

  defineTool({
    name: 'get_area',
    title: 'Get area of interest',
    description:
      'Returns one area of interest, with its GeoJSON geometry, bounding box and geodesic area.',
    safety: 'read',
    scope: 'areas:read',
    annotations: READ,
    input: z.object({ projectId, areaId }),
    output: z.object({ area: resource }),
    run: async (args, { auvryn, signal }) => ({
      area: await auvryn.areas.get({ ...args, signal }),
    }),
  }),

  defineTool({
    name: 'list_estimates',
    title: 'List cost estimates',
    description:
      'Lists the cost estimates of a project, newest first, one page at a time. Amounts are amountMinor (an integer string of minor units) with currency.',
    safety: 'read',
    scope: 'estimates:read',
    annotations: READ,
    input: z.object({ projectId, limit, cursor }),
    output: page('estimates'),
    run: async (args, { auvryn, signal }) => {
      const result = await auvryn.estimates.list({ ...args, signal });
      return { estimates: [...result.data], nextCursor: result.nextCursor };
    },
  }),

  defineTool({
    name: 'get_estimate',
    title: 'Get cost estimate',
    description:
      'Returns one cost estimate: the provider quote (amountMinor + currency), its breakdown and assumptions, the provider and the expiry. Review it before run_execution.',
    safety: 'read',
    scope: 'estimates:read',
    annotations: READ,
    input: z.object({ projectId, estimateId }),
    output: z.object({ estimate: resource }),
    run: async (args, { auvryn, signal }) => ({
      estimate: await auvryn.estimates.get({ ...args, signal }),
    }),
  }),

  defineTool({
    name: 'list_executions',
    title: 'List executions',
    description:
      'Lists the execution jobs of a project, newest first, one page at a time, optionally filtered by status (e.g. ["running"]), provider or model version.',
    safety: 'read',
    scope: 'executions:read',
    annotations: READ,
    input: z.object({
      projectId,
      status: z
        .array(z.string().regex(/^[a-z]+$/))
        .min(1)
        .max(11)
        .optional()
        .describe(
          'Only jobs in these statuses (e.g. ["running"], ["completed","failed"]); the API validates them.',
        ),
      providerId: z.string().max(100).optional().describe('Only jobs of this provider.'),
      modelVersionId: versionId.optional(),
      limit,
      cursor,
    }),
    output: page('executions'),
    run: async ({ status, ...args }, { auvryn, signal }) => {
      const result = await auvryn.executions.list({
        ...args,
        // The API validates statuses and answers VALIDATION_FAILED for unknown ones.
        ...(status === undefined ? {} : { status: status as ExecutionJobStatus[] }),
        signal,
      });
      return { executions: [...result.data], nextCursor: result.nextCursor };
    },
  }),

  defineTool({
    name: 'get_execution',
    title: 'Get execution',
    description:
      'Returns one execution job: status (created … running … completed, failed or cancelled), provider, estimate, failure reason and timestamps. Poll it, or use wait_for_execution.',
    safety: 'read',
    scope: 'executions:read',
    annotations: READ,
    input: z.object({ projectId, jobId }),
    output: z.object({ execution: resource }),
    run: async (args, { auvryn, signal }) => ({
      execution: await auvryn.executions.get({ ...args, signal }),
    }),
  }),

  defineTool({
    name: 'get_usage',
    title: 'Get usage',
    description:
      'Returns what a project (or one execution, with executionJobId) consumed — usage totals per metric — and the provider cost estimates it ran with — ledger totals per currency — plus the newest entries. This is accounting, not a bill.',
    safety: 'read',
    scope: 'usage:read',
    annotations: READ,
    input: z.object({ projectId, executionJobId: jobId.optional(), limit }),
    output: z.object({
      usage: z.object({
        totals: z.array(z.looseObject({})),
        events: z.array(resource),
        nextCursor: z.string().nullable(),
      }),
      ledger: z.object({
        totals: z.array(z.looseObject({})),
        entries: z.array(resource),
        nextCursor: z.string().nullable(),
      }),
    }),
    run: async ({ projectId: id, executionJobId, limit: size }, { auvryn, signal }) => {
      const filter = {
        projectId: id,
        limit: size,
        signal,
        ...(executionJobId ? { executionJobId } : {}),
      };
      const [usage, ledger] = await Promise.all([
        auvryn.usage.listEvents(filter),
        auvryn.usage.listLedger(filter),
      ]);
      return {
        usage: { totals: [...usage.totals], events: [...usage.data], nextCursor: usage.nextCursor },
        ledger: {
          totals: [...ledger.totals],
          entries: [...ledger.data],
          nextCursor: ledger.nextCursor,
        },
      };
    },
  }),
];
