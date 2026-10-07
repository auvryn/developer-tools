import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { readConfig } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { createAuvrynServer } from '../src/server.js';

/** A syntactically valid key that exists nowhere. */
export const API_KEY = `auv_${'0'.repeat(26)}_${'C'.repeat(42)}g`;
export const SECRET = API_KEY.slice(31);
export const ORG = 'org_01j9qmt2hy7cgsr2yefxr86ptb';
export const PROJECT = 'prj_01j9qmt2hy7cgsr2yefxr86ptc';
export const MODEL = 'mdl_01j9qmt2hy7cgsr2yefxr86ptd';
export const VERSION = 'mdlver_01j9qmt2hy7cgsr2yefxr86pte';
export const ESTIMATE = 'est_01j9qmt2hy7cgsr2yefxr86ptf';
export const JOB = 'job_01j9qmt2hy7cgsr2yefxr86ptg';
export const ARTIFACT = 'rart_01j9qmt2hy7cgsr2yefxr86pth';
export const PROJECT_PATH = `/api/v1/organizations/${ORG}/projects/${PROJECT}`;

export type Handler = (request: Request, url: URL) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_mcp', ...headers },
  });

export const apiError = (
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response =>
  json(
    { error: { code, message: `Failure ${code}.`, requestId: 'req_err', details: {} } },
    status,
    headers,
  );

const ME = {
  user: {
    id: 'usr_01j9qmt2hy7cgsr2yefxr86ptj',
    email: null,
    emailVerified: false,
    displayName: null,
  },
  principal: {
    kind: 'api-key',
    apiKeyId: 'key_01j9qmt2hy7cgsr2yefxr86ptk',
    organizationId: ORG,
    projectId: null,
    scopes: ['projects:read', 'models:read'],
  },
  session: { authenticatedAt: '2026-10-01T12:00:00.000Z', expiresAt: null },
};

/** A real MCP client connected in memory to the Auvryn MCP server, whose SDK uses a fake fetch. */
export async function connect(options: { env?: Record<string, string>; handler?: Handler } = {}) {
  const requests: Request[] = [];
  const logs: string[] = [];
  const config = readConfig({
    AUVRYN_API_KEY: API_KEY,
    AUVRYN_API_URL: 'http://api.test',
    ...options.env,
  });
  const factory = createAuvrynServer({
    config,
    logger: createLogger((line) => logs.push(line)),
    fetch: async (request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/me') {
        return json(ME);
      }
      return (options.handler ?? (() => apiError(500, 'INTERNAL_ERROR')))(request, url);
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = factory();
  await server.connect(serverTransport);
  const client = new Client({ name: 'auvryn-mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return result as {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };
  return {
    client,
    call,
    requests,
    logs,
    /** Requests other than the organization lookup. */
    apiCalls: () => requests.filter((request) => !request.url.endsWith('/api/v1/me')),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
