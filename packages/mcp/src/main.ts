#!/usr/bin/env node
import { AuvrynError } from '@auvryn/sdk';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { ConfigurationError, readConfig } from './config.js';
import { createLogger } from './log.js';
import { createAuvrynServer } from './server.js';
import { MCP_SERVER_VERSION } from './version.js';

/*
 * `auvryn-mcp`: the Auvryn MCP server over stdio. stdout carries the MCP
 * protocol only; every diagnostic goes to stderr. Configuration comes from the
 * environment (never arguments). No telemetry; no state kept between runs.
 */

const logger = createLogger();

try {
  const config = readConfig(process.env);
  const factory = createAuvrynServer({ config, logger });
  serveStdio(factory, {
    onerror: (error) => logger.event('transport-error', { name: error.name }),
  });
  logger.event('started', {
    version: MCP_SERVER_VERSION,
    apiUrl: config.apiUrl ? new URL(config.apiUrl).origin : 'default',
    executionEnabled: config.executionEnabled,
    fileAccessEnabled: config.fileRoot !== undefined,
    readOnly: config.readOnly,
  });
} catch (error) {
  // Configuration problems are reported without echoing any value.
  const message =
    error instanceof ConfigurationError || error instanceof AuvrynError
      ? error.message
      : 'Unexpected error while starting.';
  logger.event('configuration-error', { message });
  process.exitCode = 2;
}
