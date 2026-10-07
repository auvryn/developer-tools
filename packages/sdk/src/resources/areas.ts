import type { operations } from '../generated/openapi.js';
import type {
  AreaGeometry,
  AreaOfInterest,
  IdempotentOptions,
  Page,
  PageOptions,
  ProjectRef,
  RequestOptions,
} from '../types.js';
import { type Context, iteratePages, query, read, write } from './context.js';

type CreateAreaBody =
  operations['createAreaOfInterest']['requestBody']['content']['application/json'];
type UpdateAreaBody =
  operations['updateAreaOfInterest']['requestBody']['content']['application/json'];

const AREAS =
  '/api/v1/organizations/{organizationId}/projects/{projectId}/areas-of-interest' as const;

/**
 * Areas of interest: GeoJSON `Polygon` or `MultiPolygon` in longitude/latitude
 * (EPSG:4326). The API validates the geometry and computes the area.
 */
export class Areas {
  constructor(private readonly context: Context) {}

  async list(params: ProjectRef & PageOptions): Promise<Page<AreaOfInterest>> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(AREAS, {
          params: {
            path: { organizationId, projectId: params.projectId },
            query: query({ limit: params.limit, cursor: params.cursor }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.areasOfInterest, nextCursor: body.nextCursor };
  }

  iterate(
    params: ProjectRef & Omit<PageOptions, 'cursor'>,
  ): AsyncGenerator<AreaOfInterest, void, undefined> {
    return iteratePages((cursor) => this.list({ ...params, cursor }));
  }

  async get(
    params: ProjectRef & { readonly areaId: string } & RequestOptions,
  ): Promise<AreaOfInterest> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${AREAS}/{aoiId}`, {
          params: { path: { organizationId, projectId: params.projectId, aoiId: params.areaId } },
          ...init,
        }),
      read(params),
    );
  }

  async create(
    params: ProjectRef & {
      readonly name: string;
      readonly description?: string | null | undefined;
      readonly geometry: AreaGeometry;
    } & IdempotentOptions,
  ): Promise<AreaOfInterest> {
    const organizationId = await this.context.organizationId(params);
    const body = query({
      name: params.name,
      description: params.description,
      geometry: params.geometry,
    }) as CreateAreaBody;
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(AREAS, {
          params: { path: { organizationId, projectId: params.projectId } },
          body,
          ...init,
        }),
      write(params),
    );
  }

  /** Changes the name, description or geometry (a new geometry is fully re-validated). */
  async update(
    params: ProjectRef & {
      readonly areaId: string;
      readonly name?: string | undefined;
      readonly description?: string | null | undefined;
      readonly geometry?: AreaGeometry | undefined;
    } & RequestOptions,
  ): Promise<AreaOfInterest> {
    const organizationId = await this.context.organizationId(params);
    const body = query({
      name: params.name,
      description: params.description,
      geometry: params.geometry,
    }) as UpdateAreaBody;
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.PATCH(`${AREAS}/{aoiId}`, {
          params: { path: { organizationId, projectId: params.projectId, aoiId: params.areaId } },
          body,
          ...init,
        }),
      write(params),
    );
  }
}
