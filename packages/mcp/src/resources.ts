import type { Auvryn } from '@auvryn/sdk';
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server';

import type { McpConfig } from './config.js';
import { LocalError, errorDetails, errorText } from './errors.js';
import type { Logger } from './log.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from './version.js';

/*
 * Resources: read-only context an agent (or a person in the client) can
 * attach. JSON, bounded (one page of at most RESOURCE_PAGE items, with a
 * `nextCursor` hint pointing to the list tools), and authorized by Auvryn
 * exactly like the tools: the API key's scopes and project decide.
 */

export const RESOURCE_PAGE = 50;
const ID = /^[a-z]+_[0-9a-hjkmnp-tv-z]{26}$/;

type Variables = Record<string, string | string[]>;

function variable(variables: Variables, name: string, prefix: string): string {
  const raw = variables[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !ID.test(value) || !value.startsWith(`${prefix}_`)) {
    throw new LocalError('INVALID_RESOURCE_URI', `${name} must be a ${prefix}_… ID.`);
  }
  return value;
}

export function registerResources(
  server: McpServer,
  { auvryn, config, logger }: { auvryn: Auvryn; config: McpConfig; logger: Logger },
): void {
  /** Reads one resource as JSON, logging and translating failures. */
  const json =
    <Args extends unknown[]>(name: string, read: (...args: Args) => Promise<unknown>) =>
    async (uri: URL, ...args: Args) => {
      const started = performance.now();
      try {
        const body = await read(...args);
        logger.event('resource', {
          resource: name,
          status: 'ok',
          durationMs: Math.round(performance.now() - started),
        });
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) },
          ],
        };
      } catch (error) {
        const details = errorDetails(error);
        logger.event('resource', {
          resource: name,
          status: 'error',
          code: details.code,
          ...(details.requestId ? { requestId: details.requestId } : {}),
          durationMs: Math.round(performance.now() - started),
        });
        throw new Error(errorText(details), { cause: error });
      }
    };

  const template = (uriTemplate: string, listProjects = false) =>
    new ResourceTemplate(uriTemplate, {
      // Enumerating projects must never break resource discovery (e.g. a key
      // without projects:read): on failure the list is empty and the cause logged.
      list: listProjects
        ? async () => {
            try {
              return {
                resources: (await auvryn.projects.list()).data.map((project) => ({
                  uri: `auvryn://projects/${project.id}`,
                  name: project.name,
                  mimeType: 'application/json',
                })),
              };
            } catch (error) {
              logger.event('resource', {
                resource: 'project-list',
                status: 'error',
                code: errorDetails(error).code,
              });
              return { resources: [] };
            }
          }
        : undefined,
    });

  const page = <T>(items: readonly T[], nextCursor: string | null, tool: string) => ({
    items,
    nextCursor,
    ...(nextCursor === null
      ? {}
      : { more: `More items exist: call ${tool} with cursor ${nextCursor}.` }),
  });

  server.registerResource(
    'session',
    'auvryn://session',
    {
      title: 'Auvryn session',
      description:
        'The MCP server, the API key in use (public ID, organization, project, scopes; never the key) and the server gates.',
      mimeType: 'application/json',
    },
    json('session', async () => {
      const me = await auvryn.me();
      return {
        server: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        principal: me.principal,
        gates: {
          executionEnabled: config.executionEnabled,
          fileAccessEnabled: config.fileRoot !== undefined,
          readOnly: config.readOnly,
        },
      };
    }),
  );

  server.registerResource(
    'projects',
    'auvryn://projects',
    {
      title: 'Projects',
      description: 'The projects this API key can reach.',
      mimeType: 'application/json',
    },
    json('projects', async () => ({ items: (await auvryn.projects.list()).data })),
  );

  server.registerResource(
    'project',
    template('auvryn://projects/{projectId}', true),
    { title: 'Project', description: 'One project.', mimeType: 'application/json' },
    json('project', async (variables: Variables) =>
      auvryn.projects.get({ projectId: variable(variables, 'projectId', 'prj') }),
    ),
  );

  server.registerResource(
    'project-models',
    template('auvryn://projects/{projectId}/models'),
    {
      title: 'Project models',
      description: `The newest ${String(RESOURCE_PAGE)} models of a project (list_models pages further).`,
      mimeType: 'application/json',
    },
    json('project-models', async (variables: Variables) => {
      const result = await auvryn.models.list({
        projectId: variable(variables, 'projectId', 'prj'),
        limit: RESOURCE_PAGE,
      });
      return page(result.data, result.nextCursor, 'list_models');
    }),
  );

  server.registerResource(
    'project-areas',
    template('auvryn://projects/{projectId}/areas'),
    {
      title: 'Project areas of interest',
      description: `The newest ${String(RESOURCE_PAGE)} areas of a project, as summaries without geometry (get_area returns one geometry).`,
      mimeType: 'application/json',
    },
    json('project-areas', async (variables: Variables) => {
      const result = await auvryn.areas.list({
        projectId: variable(variables, 'projectId', 'prj'),
        limit: RESOURCE_PAGE,
      });
      return page(
        result.data.map((area) => ({
          id: area.id,
          name: area.name,
          areaSquareMeters: area.areaSquareMeters,
          createdAt: area.createdAt,
        })),
        result.nextCursor,
        'list_areas',
      );
    }),
  );

  server.registerResource(
    'project-executions',
    template('auvryn://projects/{projectId}/executions'),
    {
      title: 'Project executions',
      description: `The newest ${String(RESOURCE_PAGE)} executions of a project (list_executions filters and pages further).`,
      mimeType: 'application/json',
    },
    json('project-executions', async (variables: Variables) => {
      const result = await auvryn.executions.list({
        projectId: variable(variables, 'projectId', 'prj'),
        limit: RESOURCE_PAGE,
      });
      return page(result.data, result.nextCursor, 'list_executions');
    }),
  );

  server.registerResource(
    'execution',
    template('auvryn://projects/{projectId}/executions/{jobId}'),
    { title: 'Execution', description: 'One execution job.', mimeType: 'application/json' },
    json('execution', async (variables: Variables) =>
      auvryn.executions.get({
        projectId: variable(variables, 'projectId', 'prj'),
        jobId: variable(variables, 'jobId', 'job'),
      }),
    ),
  );

  server.registerResource(
    'execution-result',
    template('auvryn://projects/{projectId}/executions/{jobId}/result'),
    {
      title: 'Execution result',
      description:
        'The result of a completed execution: provenance, summary and artifact metadata (never artifact content).',
      mimeType: 'application/json',
    },
    json('execution-result', async (variables: Variables) =>
      auvryn.results.get({
        projectId: variable(variables, 'projectId', 'prj'),
        jobId: variable(variables, 'jobId', 'job'),
      }),
    ),
  );

  server.registerResource(
    'project-usage',
    template('auvryn://projects/{projectId}/usage'),
    {
      title: 'Project usage',
      description:
        'Usage totals per metric and provider cost estimate totals per currency for a project (not billing).',
      mimeType: 'application/json',
    },
    json('project-usage', async (variables: Variables) => {
      const projectId = variable(variables, 'projectId', 'prj');
      const [usage, ledger] = await Promise.all([
        auvryn.usage.listEvents({ projectId, limit: 1 }),
        auvryn.usage.listLedger({ projectId, limit: 1 }),
      ]);
      return {
        usageTotals: usage.totals,
        ledgerTotals: ledger.totals,
        note: 'Accounting, not a bill. get_usage lists entries.',
      };
    }),
  );
}
