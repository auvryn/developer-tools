import type {
  CostEstimate,
  IdempotentOptions,
  Page,
  PageOptions,
  ProjectRef,
  RequestOptions,
} from '../types.js';
import { type Context, iteratePages, query, read, write } from './context.js';

const ESTIMATES =
  '/api/v1/organizations/{organizationId}/projects/{projectId}/cost-estimates' as const;

/**
 * Cost estimates: immutable provider quotes for running a validated model
 * version (optionally over an area). Money is `amountMinor` (a decimal string
 * of minor units) with `currency`. A quote, not a bill.
 */
export class Estimates {
  constructor(private readonly context: Context) {}

  async list(params: ProjectRef & PageOptions): Promise<Page<CostEstimate>> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(ESTIMATES, {
          params: {
            path: { organizationId, projectId: params.projectId },
            query: query({ limit: params.limit, cursor: params.cursor }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.costEstimates, nextCursor: body.nextCursor };
  }

  iterate(
    params: ProjectRef & Omit<PageOptions, 'cursor'>,
  ): AsyncGenerator<CostEstimate, void, undefined> {
    return iteratePages((cursor) => this.list({ ...params, cursor }));
  }

  async get(
    params: ProjectRef & { readonly estimateId: string } & RequestOptions,
  ): Promise<CostEstimate> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${ESTIMATES}/{estimateId}`, {
          params: {
            path: { organizationId, projectId: params.projectId, estimateId: params.estimateId },
          },
          ...init,
        }),
      read(params),
    );
  }

  /** Asks the provider for a quote (synchronous; nothing is stored if the provider fails). */
  async create(
    params: ProjectRef & {
      readonly modelVersionId: string;
      readonly providerId: string;
      readonly areaOfInterestId?: string | null | undefined;
    } & IdempotentOptions,
  ): Promise<CostEstimate> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(ESTIMATES, {
          params: { path: { organizationId, projectId: params.projectId } },
          body: query({
            modelVersionId: params.modelVersionId,
            providerId: params.providerId,
            areaOfInterestId: params.areaOfInterestId,
          }) as { modelVersionId: string; providerId: string; areaOfInterestId?: string | null },
          ...init,
        }),
      write(params),
    );
  }
}
