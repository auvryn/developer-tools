import { Auvryn, type AuvrynOptions } from '../src/index.js';

/** A syntactically valid key that exists nowhere. */
export const API_KEY = `auv_${'0'.repeat(26)}_${'A'.repeat(42)}Q`;
export const SECRET = API_KEY.slice(31);
export const ORG = 'org_01j9qmt2hy7cgsr2yefxr86ptb';
export const PROJECT = 'prj_01j9qmt2hy7cgsr2yefxr86ptc';
export const BASE_URL = 'http://api.test';

export type Handler = (request: Request, url: URL) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test', ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
  details: Record<string, unknown> = {},
): Response {
  return json(
    { error: { code, message: `Failure ${code}.`, requestId: 'req_err', details } },
    status,
    headers,
  );
}

export const ME = {
  user: {
    id: 'usr_01j9qmt2hy7cgsr2yefxr86pte',
    email: null,
    emailVerified: false,
    displayName: null,
  },
  principal: {
    kind: 'api-key',
    apiKeyId: 'key_01j9qmt2hy7cgsr2yefxr86ptd',
    organizationId: ORG,
    projectId: null,
    scopes: ['models:read'],
  },
  session: { authenticatedAt: '2026-10-01T12:00:00.000Z', expiresAt: null },
};

/** A client whose `fetch` records every request and answers with `handler` (`/me` built in). */
export function fakeClient(handler: Handler, options: AuvrynOptions = {}) {
  const requests: Request[] = [];
  const client = new Auvryn({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    ...options,
    fetch: async (request) => {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/me') {
        return json(ME);
      }
      return handler(request, url);
    },
  });
  return {
    client,
    requests,
    calls: (path: string) => requests.filter((r) => new URL(r.url).pathname === path),
  };
}

export const MODELS_PATH = `/api/v1/organizations/${ORG}/projects/${PROJECT}/models`;
export const JOBS_PATH = `/api/v1/organizations/${ORG}/projects/${PROJECT}/execution-jobs`;
