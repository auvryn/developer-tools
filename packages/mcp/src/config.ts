import { isAbsolute } from 'node:path';

/*
 * MCP server configuration, from the environment only (never arguments: a key
 * in argv would be visible in process lists and client configs' logs).
 *
 * Safe defaults (ADR-0026): reads and safe writes enabled; execution and
 * cancellation disabled; no local file access.
 */

export interface McpConfig {
  /** `AUVRYN_API_KEY`: the same API key an SDK or CLI user would use. */
  readonly apiKey: string;
  /** `AUVRYN_API_URL` (the SDK's default when absent). */
  readonly apiUrl: string | undefined;
  /** `AUVRYN_MCP_EXECUTION_ENABLED=true`: allow `run_execution` and `cancel_execution`. */
  readonly executionEnabled: boolean;
  /** `AUVRYN_MCP_READ_ONLY=true`: refuse every write tool locally (on top of the key's scopes). */
  readonly readOnly: boolean;
  /**
   * `AUVRYN_MCP_FILE_ROOT`: the only directory model uploads may read from and
   * artifact downloads may write to. Unset: no file access at all.
   */
  readonly fileRoot: string | undefined;
}

export class ConfigurationError extends Error {}

const flag = (value: string | undefined, name: string): boolean => {
  if (value === undefined || value === '') {
    return false;
  }
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }
  throw new ConfigurationError(`${name} must be "true" or "false".`);
};

export function readConfig(env: Readonly<Record<string, string | undefined>>): McpConfig {
  const apiKey = env['AUVRYN_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new ConfigurationError(
      'AUVRYN_API_KEY is not set. Configure it in the MCP client\'s "env" for this server.',
    );
  }
  const fileRoot = env['AUVRYN_MCP_FILE_ROOT']?.trim();
  if (fileRoot !== undefined && fileRoot !== '' && !isAbsolute(fileRoot)) {
    throw new ConfigurationError('AUVRYN_MCP_FILE_ROOT must be an absolute path.');
  }
  return {
    apiKey,
    apiUrl: env['AUVRYN_API_URL']?.trim() || undefined,
    executionEnabled: flag(env['AUVRYN_MCP_EXECUTION_ENABLED'], 'AUVRYN_MCP_EXECUTION_ENABLED'),
    readOnly: flag(env['AUVRYN_MCP_READ_ONLY'], 'AUVRYN_MCP_READ_ONLY'),
    fileRoot: fileRoot === undefined || fileRoot === '' ? undefined : fileRoot,
  };
}
