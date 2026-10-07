import { pollUntil } from '../poll.js';
import type {
  CreatedExecutionJob,
  ExecutionJob,
  ExecutionJobStatus,
  ExecutionRef,
  IdempotentOptions,
  Page,
  PageOptions,
  ProjectRef,
  RequestOptions,
  WaitOptions,
} from '../types.js';
import { type Context, iteratePages, query, read, write } from './context.js';

const JOBS = '/api/v1/organizations/{organizationId}/projects/{projectId}/execution-jobs' as const;
const SAMPLE_WORKLOADS =
  '/api/v1/organizations/{organizationId}/projects/{projectId}/sample-workloads' as const;

/** Final statuses of an execution job (the API's contract; nothing changes after them). */
export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionJobStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export const DEFAULT_EXECUTION_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_EXECUTION_INTERVAL_MS = 3_000;

export interface ExecutionFilters {
  readonly status?: ExecutionJobStatus | readonly ExecutionJobStatus[] | undefined;
  readonly providerId?: string | undefined;
  readonly modelVersionId?: string | undefined;
  /** Inclusive lower bound of `createdAt`. */
  readonly createdAfter?: Date | string | undefined;
  /** Exclusive upper bound of `createdAt`. */
  readonly createdBefore?: Date | string | undefined;
}

/** Runs the workload a cost estimate priced (preferred). */
export interface CreateFromEstimate {
  readonly costEstimateId: string;
}

/** Runs a model version directly on a provider (no estimate). */
export interface CreateDirect {
  readonly modelVersionId: string;
  readonly providerId: string;
  readonly areaOfInterestId?: string | null | undefined;
}

const iso = (value: Date | string | undefined) =>
  value instanceof Date ? value.toISOString() : value;

/**
 * Execution jobs. Creating one returns immediately (`202`); the worker runs it
 * through the provider. Poll with `get` or `wait`.
 */
export class Executions {
  constructor(private readonly context: Context) {}

  async list(params: ProjectRef & ExecutionFilters & PageOptions): Promise<Page<ExecutionJob>> {
    const organizationId = await this.context.organizationId(params);
    const status =
      params.status === undefined
        ? undefined
        : (Array.isArray(params.status) ? params.status : [params.status]).join(',');
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(JOBS, {
          params: {
            path: { organizationId, projectId: params.projectId },
            query: query({
              limit: params.limit,
              cursor: params.cursor,
              status,
              providerId: params.providerId,
              modelVersionId: params.modelVersionId,
              createdAfter: iso(params.createdAfter),
              createdBefore: iso(params.createdBefore),
            }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.executionJobs, nextCursor: body.nextCursor };
  }

  iterate(
    params: ProjectRef & ExecutionFilters & Omit<PageOptions, 'cursor'>,
  ): AsyncGenerator<ExecutionJob, void, undefined> {
    return iteratePages((cursor) => this.list({ ...params, cursor }));
  }

  async get(params: ExecutionRef & RequestOptions): Promise<ExecutionJob> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${JOBS}/{jobId}`, {
          params: { path: { organizationId, projectId: params.projectId, jobId: params.jobId } },
          ...init,
        }),
      read(params),
    );
  }

  /**
   * Creates an execution job and returns at once (it does not wait). Pass an
   * `idempotencyKey` to make retries safe: without one the SDK never retries,
   * because a repeated create would start a second execution.
   */
  async create(
    params: ProjectRef & (CreateFromEstimate | CreateDirect) & IdempotentOptions,
  ): Promise<CreatedExecutionJob> {
    const organizationId = await this.context.organizationId(params);
    const body =
      'costEstimateId' in params
        ? { costEstimateId: params.costEstimateId }
        : (query({
            modelVersionId: params.modelVersionId,
            providerId: params.providerId,
            areaOfInterestId: params.areaOfInterestId,
          }) as { modelVersionId: string; providerId: string; areaOfInterestId?: string | null });
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(JOBS, {
          params: { path: { organizationId, projectId: params.projectId } },
          body,
          ...init,
        }),
      write(params),
    );
  }

  /**
   * Runs Auvryn's sample model on the Sample Environment and returns at once
   * (`202`; follow it with `wait`). The execution is **simulated**: no model is
   * executed on real hardware, and its provenance says `simulated: true`. It
   * names no model and no provider, needs the workspace's `sample-workload`
   * capability, and counts toward the daily sample-run limit. Pass an
   * `idempotencyKey` to make retries safe (without one the SDK never retries).
   */
  async createSample(params: ProjectRef & IdempotentOptions): Promise<CreatedExecutionJob> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(SAMPLE_WORKLOADS, {
          params: { path: { organizationId, projectId: params.projectId } },
          body: {},
          ...init,
        }),
      write(params),
    );
  }

  /** Requests cancellation; the job ends `cancelled` once the provider confirms. */
  async cancel(params: ExecutionRef & RequestOptions): Promise<ExecutionJob> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(`${JOBS}/{jobId}/cancel`, {
          params: { path: { organizationId, projectId: params.projectId, jobId: params.jobId } },
          ...init,
        }),
      write(params),
    );
  }

  /**
   * Polls until the job is `completed`, `failed` or `cancelled` and returns it
   * (check `status`). Default timeout 30 minutes, interval 3 seconds.
   */
  wait(params: ExecutionRef & WaitOptions): Promise<ExecutionJob> {
    return pollUntil(
      () => this.get(params),
      (job) => TERMINAL_EXECUTION_STATUSES.includes(job.status),
      {
        timeoutMs: params.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
        intervalMs: params.intervalMs ?? DEFAULT_EXECUTION_INTERVAL_MS,
        signal: params.signal,
        description: `Execution job ${params.jobId}`,
      },
    );
  }
}
