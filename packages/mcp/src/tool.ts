import type { Auvryn } from '@auvryn/sdk';
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { McpConfig } from './config.js';
import { LocalError, errorDetails, errorText } from './errors.js';
import { type Logger, publicIds } from './log.js';

/*
 * How every tool is declared: a safety class (the basis for approvals), the
 * API scope it needs, honest MCP annotations, strict input and output schemas,
 * and a handler that only calls the SDK. The local gates run before the
 * handler, so a refused call never reaches the API.
 */

/**
 * - `read`: reads Auvryn; no side effects.
 * - `write`: creates or changes Auvryn records (models, uploads, validation,
 *   sandbox runs, areas, estimates); no external infrastructure is used.
 * - `cost-sensitive`: starts or stops work on execution infrastructure
 *   (`run_execution`, `cancel_execution`); disabled unless
 *   AUVRYN_MCP_EXECUTION_ENABLED=true.
 * - `local-file`: writes to the local filesystem (inside AUVRYN_MCP_FILE_ROOT).
 */
export type Safety = 'read' | 'write' | 'cost-sensitive' | 'local-file';

export interface ToolContext {
  readonly auvryn: Auvryn;
  readonly config: McpConfig;
  readonly signal: AbortSignal;
}

export interface ToolSpec<Input extends z.ZodObject, Output extends z.ZodObject> {
  readonly name: string;
  readonly title: string;
  /** What it does, preconditions, side effects, cost, reversibility and what it returns. */
  readonly description: string;
  readonly safety: Safety;
  /** The API key scope the call needs (`null`: any valid key). */
  readonly scope: string | null;
  readonly annotations: ToolAnnotations;
  readonly input: Input;
  readonly output: Output;
  readonly run: (args: z.infer<Input>, context: ToolContext) => Promise<z.infer<Output>>;
}

/** Type-erased, for the catalog. */
export type AnyToolSpec = ToolSpec<z.ZodObject, z.ZodObject>;

export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
  spec: ToolSpec<Input, Output>,
): AnyToolSpec {
  return spec;
}

const SAFETY_NOTE: Record<Safety, string> = {
  read: 'Safety: READ (no side effects).',
  write:
    'Safety: WRITE (creates or changes Auvryn records; does not use execution infrastructure).',
  'cost-sensitive':
    'Safety: COST-SENSITIVE (affects execution infrastructure and future cost). Disabled unless the server runs with AUVRYN_MCP_EXECUTION_ENABLED=true; a person should approve each call.',
  'local-file':
    'Safety: LOCAL FILE (writes a file on this machine, only inside AUVRYN_MCP_FILE_ROOT).',
};

/** Local gates: decided before any API call. */
export function checkGates(spec: AnyToolSpec, config: McpConfig): void {
  if (spec.safety !== 'read' && config.readOnly) {
    throw new LocalError(
      'READ_ONLY_MODE',
      'This MCP server runs in read-only mode (AUVRYN_MCP_READ_ONLY=true); write tools are refused.',
    );
  }
  if (spec.safety === 'cost-sensitive' && !config.executionEnabled) {
    throw new LocalError(
      'EXECUTION_DISABLED',
      `${spec.name} is disabled in this MCP server. Executions use external infrastructure and may cost money, so a person must explicitly enable them with AUVRYN_MCP_EXECUTION_ENABLED=true. Nothing was sent to Auvryn.`,
    );
  }
}

export function registerTool(
  server: McpServer,
  spec: AnyToolSpec,
  dependencies: { readonly auvryn: Auvryn; readonly config: McpConfig; readonly logger: Logger },
): void {
  const description = [
    spec.description,
    '',
    SAFETY_NOTE[spec.safety],
    `Required API key scope: ${spec.scope ?? 'none (any valid key)'}. Auvryn enforces it; a key without it gets INSUFFICIENT_SCOPE.`,
  ].join('\n');
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: { title: spec.title, ...spec.annotations },
      _meta: { 'auvryn/safety': spec.safety, 'auvryn/scope': spec.scope },
    },
    async (args: unknown, ctx) => {
      const started = performance.now();
      const ids = publicIds(args);
      try {
        checkGates(spec, dependencies.config);
        const output = await spec.run(args as never, {
          auvryn: dependencies.auvryn,
          config: dependencies.config,
          signal: ctx.mcpReq.signal,
        });
        dependencies.logger.event('tool', {
          tool: spec.name,
          status: 'ok',
          durationMs: Math.round(performance.now() - started),
          ids,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        const details = errorDetails(error);
        dependencies.logger.event('tool', {
          tool: spec.name,
          status: 'error',
          code: details.code,
          ...(details.requestId ? { requestId: details.requestId } : {}),
          durationMs: Math.round(performance.now() - started),
          ids,
        });
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorText(details) }],
          structuredContent: { error: details },
        };
      }
    },
  );
}
