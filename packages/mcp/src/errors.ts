import { AuvrynError, RateLimitError, WaitTimeoutError } from '@auvryn/sdk';

/*
 * Tool failures as MCP tool results (`isError: true`), so the agent sees them
 * and can react: a short text plus `structuredContent.error` with the same
 * machine-readable fields as the SDK (code, message, status, requestId). Never
 * a stack trace, request headers or the API key.
 */

/** A refusal decided by the MCP server itself, before any API call. */
export class LocalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ToolErrorDetails {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function errorDetails(error: unknown): ToolErrorDetails {
  if (error instanceof LocalError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof RateLimitError) {
    return {
      code: error.code,
      message: `${error.message} Retry after ${String(error.retryAfterSeconds)} seconds.`,
      status: error.status,
      retryAfterSeconds: error.retryAfterSeconds,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  if (error instanceof WaitTimeoutError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof AuvrynError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(Object.keys(error.details).length === 0 ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: 'The request was cancelled.' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Unexpected error in the Auvryn MCP server.' };
}

/** The text an agent reads first: what failed, why, and how to correlate it. */
export function errorText(error: ToolErrorDetails): string {
  return [
    `Error ${error.code}${error.status === undefined ? '' : ` (HTTP ${String(error.status)})`}: ${error.message}`,
    ...(error.requestId ? [`Request ID: ${error.requestId}`] : []),
  ].join('\n');
}
