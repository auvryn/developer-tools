import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import { AuvrynError } from './errors.js';
import { Areas } from './resources/areas.js';
import { type Context, read } from './resources/context.js';
import { Estimates } from './resources/estimates.js';
import { Executions } from './resources/executions.js';
import { Models } from './resources/models.js';
import { Projects, Providers, Workspace } from './resources/projects.js';
import { Results, Usage } from './resources/results.js';
import { Sandbox } from './resources/sandbox.js';
import { Transport } from './transport.js';
import type { Me, Organization, RequestOptions } from './types.js';
import { API_VERSION, SDK_VERSION } from './version.js';

/** `auv_<26-character key ID>_<43-character secret>` (docs/api/authentication.md). */
const API_KEY_PATTERN = /^auv_[0-9a-hjkmnp-tv-z]{26}_[A-Za-z0-9_-]{43}$/;

/** No hosted endpoint exists yet: local development is the default. */
/** Auvryn's production API. A local stack is an explicit override (`baseUrl` or `AUVRYN_API_URL`). */
export const DEFAULT_BASE_URL = 'https://api.auvrynspace.com';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface AuvrynOptions {
  /** An API key (`auv_…`). Defaults to `AUVRYN_API_KEY`. Kept in memory only. */
  readonly apiKey?: string | undefined;
  /** The API's origin (without `/api/v1`). Defaults to `AUVRYN_API_URL`, then `https://api.auvrynspace.com`. */
  readonly baseUrl?: string | undefined;
  /** Skips resolving the key's organization (`GET /api/v1/me`) on the first call. */
  readonly organizationId?: string | undefined;
  /** Per-request timeout of JSON calls (default 30 s). Uploads, downloads and waits have their own bounds. */
  readonly timeoutMs?: number | undefined;
  /** Prepended to the SDK's `User-Agent` (e.g. `my-pipeline/2.1`). */
  readonly userAgent?: string | undefined;
  /** A `fetch` implementation (tests, proxies). Defaults to the global `fetch`. */
  readonly fetch?: ((request: Request) => Promise<Response>) | undefined;
}

/** What `inspect()` reveals about a client: never the API key. */
export interface ClientDescription {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly sdkVersion: string;
  readonly userAgent: string;
  readonly apiKey: '[REDACTED]';
}

/**
 * The Auvryn client for Node.js (Developer API v1).
 *
 * ```ts
 * const auvryn = new Auvryn({ apiKey: process.env.AUVRYN_API_KEY });
 * const { data: projects } = await auvryn.projects.list();
 * ```
 */
export class Auvryn {
  /** A fresh, random `Idempotency-Key`. Generate it once per logical operation and reuse it on retries. */
  static idempotencyKey(): string {
    return randomUUID();
  }

  readonly projects: Projects;
  readonly providers: Providers;
  readonly models: Models;
  readonly sandbox: Sandbox;
  readonly areas: Areas;
  readonly estimates: Estimates;
  readonly executions: Executions;
  readonly results: Results;
  readonly usage: Usage;
  /** The key's workspace: capabilities, limits with usage, and activation events (read only). */
  readonly workspace: Workspace;

  readonly #transport: Transport;
  #organizationId: Promise<string> | undefined;

  constructor(options: AuvrynOptions = {}) {
    const apiKey = (options.apiKey ?? process.env['AUVRYN_API_KEY'] ?? '').trim();
    if (apiKey === '') {
      throw new AuvrynError({
        code: 'API_KEY_REQUIRED',
        message: 'An API key is required: pass apiKey or set AUVRYN_API_KEY.',
      });
    }
    if (!API_KEY_PATTERN.test(apiKey)) {
      throw new AuvrynError({
        code: 'API_KEY_INVALID_FORMAT',
        message: 'The API key is not an Auvryn API key (expected auv_<key id>_<secret>).',
      });
    }
    const baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env['AUVRYN_API_URL'] ?? DEFAULT_BASE_URL,
    );
    const userAgent = [options.userAgent, `auvryn-js/${SDK_VERSION}`]
      .filter((part) => part !== undefined && part !== '')
      .join(' ');
    this.#transport = new Transport({
      apiKey,
      baseUrl,
      userAgent,
      timeoutMs: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetch: options.fetch,
    });
    if (options.organizationId !== undefined) {
      this.#organizationId = Promise.resolve(options.organizationId);
    }
    const context: Context = {
      transport: this.#transport,
      organizationId: (requestOptions) => this.organizationId(requestOptions),
    };
    this.projects = new Projects(context);
    this.providers = new Providers(context);
    this.workspace = new Workspace(context);
    this.models = new Models(context);
    this.sandbox = new Sandbox(context);
    this.areas = new Areas(context);
    this.estimates = new Estimates(context);
    this.executions = new Executions(context);
    this.results = new Results(context);
    this.usage = new Usage(context);
  }

  /** The API key's principal: key ID, organization, project restriction and scopes. */
  me(options: RequestOptions = {}): Promise<Me> {
    return this.#transport.call(
      (init) => this.#transport.client.GET('/api/v1/me', { ...init }),
      read(options),
    );
  }

  /** The API key's organization. */
  async organization(options: RequestOptions = {}): Promise<Organization> {
    const organizationId = await this.organizationId(options);
    return this.#transport.call(
      (init) =>
        this.#transport.client.GET('/api/v1/organizations/{organizationId}', {
          params: { path: { organizationId } },
          ...init,
        }),
      read(options),
    );
  }

  /** The ID of the key's organization, resolved once (a failed lookup is retried next time). */
  organizationId(options: RequestOptions = {}): Promise<string> {
    this.#organizationId ??= this.me(options).then((me) => {
      if (me.principal.kind !== 'api-key') {
        throw new AuvrynError({
          code: 'ORGANIZATION_UNAVAILABLE',
          message: 'The credential is not an API key; pass organizationId explicitly.',
        });
      }
      return me.principal.organizationId;
    });
    const pending = this.#organizationId;
    pending.catch(() => {
      if (this.#organizationId === pending) {
        this.#organizationId = undefined;
      }
    });
    return pending;
  }

  /** A safe description of this client (the API key is never included). */
  inspect(): ClientDescription {
    return {
      baseUrl: this.#transport.baseUrl,
      apiVersion: API_VERSION,
      sdkVersion: SDK_VERSION,
      userAgent: this.#transport.userAgent,
      apiKey: '[REDACTED]',
    };
  }

  toJSON(): ClientDescription {
    return this.inspect();
  }

  [inspect.custom](): string {
    return `Auvryn ${inspect(this.inspect())}`;
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuvrynError({
      code: 'INVALID_BASE_URL',
      message: 'baseUrl must be an absolute http(s) URL.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuvrynError({
      code: 'INVALID_BASE_URL',
      message: 'baseUrl must be an absolute http(s) URL.',
    });
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new AuvrynError({
      code: 'INVALID_BASE_URL',
      message: 'baseUrl must not contain credentials, a query or a fragment.',
    });
  }
  return url.href.replace(/\/+$/, '');
}
