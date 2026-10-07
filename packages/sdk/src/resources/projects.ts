import type {
  Page,
  PageOptions,
  Project,
  Provider,
  RequestOptions,
  WorkspaceEntitlements,
  WorkspaceEvent,
} from '../types.js';
import { type Context, iteratePages, query, read, singlePage } from './context.js';

/** Filters of the workspace's events. */
export interface WorkspaceEventFilter {
  readonly type?: WorkspaceEvent['type'] | undefined;
  /** Only events about this resource (e.g. a `prj_`, `mdlver_` or `job_` ID). */
  readonly resourceId?: string | undefined;
}

/** Projects the API key can reach (all of its organization's, or its one project). */
export class Projects {
  constructor(private readonly context: Context) {}

  async list(options: RequestOptions = {}): Promise<Page<Project>> {
    const organizationId = await this.context.organizationId(options);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET('/api/v1/organizations/{organizationId}/projects', {
          params: { path: { organizationId } },
          ...init,
        }),
      read(options),
    );
    return singlePage(body.projects);
  }

  async get(params: { readonly projectId: string } & RequestOptions): Promise<Project> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(
          '/api/v1/organizations/{organizationId}/projects/{projectId}',
          { params: { path: { organizationId, projectId: params.projectId } }, ...init },
        ),
      read(params),
    );
  }
}

/** Execution providers selectable in this environment. */
export class Providers {
  constructor(private readonly context: Context) {}

  async list(options: RequestOptions = {}): Promise<Page<Provider>> {
    const body = await this.context.transport.call(
      (init) => this.context.transport.client.GET('/api/v1/providers', { ...init }),
      read(options),
    );
    return singlePage(body.providers);
  }
}

/** The API key's workspace: what it may use and how much (read only). */
export class Workspace {
  constructor(private readonly context: Context) {}

  /**
   * Capabilities (`enabled`, `disabled` or `expired`) and limits with current
   * usage. Enabling or raising them is done by Auvryn, never through the API.
   */
  async entitlements(options: RequestOptions = {}): Promise<WorkspaceEntitlements> {
    const organizationId = await this.context.organizationId(options);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET('/api/v1/organizations/{organizationId}/entitlements', {
          params: { path: { organizationId } },
          ...init,
        }),
      read(options),
    );
  }

  /**
   * A page of the workspace's activation events, newest first (default 50,
   * at most 100 per page): projects, models, validations, sample runs and
   * executions. Audit events are never listed for API keys.
   */
  async events(params: WorkspaceEventFilter & PageOptions = {}): Promise<Page<WorkspaceEvent>> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET('/api/v1/organizations/{organizationId}/events', {
          params: {
            path: { organizationId },
            query: query({
              limit: params.limit,
              cursor: params.cursor,
              type: params.type,
              resourceId: params.resourceId,
            }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.events, nextCursor: body.nextCursor };
  }

  /** Every matching workspace event, newest first, page by page. */
  iterateEvents(
    params: WorkspaceEventFilter & Omit<PageOptions, 'cursor'> = {},
  ): AsyncGenerator<WorkspaceEvent, void, undefined> {
    return iteratePages((cursor) => this.events({ ...params, cursor }));
  }
}
