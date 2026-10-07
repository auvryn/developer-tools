import { pollUntil } from '../poll.js';
import type {
  IdempotentOptions,
  ModelVersionRef,
  Page,
  RequestOptions,
  SandboxRun,
  WaitOptions,
} from '../types.js';
import { type Context, read, singlePage, write } from './context.js';

const RUNS =
  '/api/v1/organizations/{organizationId}/projects/{projectId}/models/{modelId}/versions/{versionId}/sandbox-runs' as const;

const FINAL_SANDBOX_STATUSES: ReadonlySet<SandboxRun['status']> = new Set(['completed', 'failed']);

export const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_SANDBOX_INTERVAL_MS = 2_000;

export interface SandboxRunRef extends ModelVersionRef {
  readonly sandboxRunId: string;
}

/** Sandbox test runs of a validated model version (ONNX Runtime, isolated). */
export class Sandbox {
  constructor(private readonly context: Context) {}

  /** Starts a run (`pending`); the worker runs it. Use `wait` for the outcome. */
  async run(params: ModelVersionRef & IdempotentOptions): Promise<SandboxRun> {
    const path = await this.path(params);
    return this.context.transport.call(
      (init) => this.context.transport.client.POST(RUNS, { params: { path }, ...init }),
      write(params),
    );
  }

  async get(params: SandboxRunRef & RequestOptions): Promise<SandboxRun> {
    const path = await this.path(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${RUNS}/{sandboxRunId}`, {
          params: { path: { ...path, sandboxRunId: params.sandboxRunId } },
          ...init,
        }),
      read(params),
    );
  }

  /** Runs of the version, newest first. */
  async list(params: ModelVersionRef & RequestOptions): Promise<Page<SandboxRun>> {
    const path = await this.path(params);
    const body = await this.context.transport.call(
      (init) => this.context.transport.client.GET(RUNS, { params: { path }, ...init }),
      read(params),
    );
    return singlePage(body.sandboxRuns);
  }

  /** Polls until the run is `completed` or `failed` (default timeout 10 minutes). */
  wait(params: SandboxRunRef & WaitOptions): Promise<SandboxRun> {
    return pollUntil(
      () => this.get(params),
      (run) => FINAL_SANDBOX_STATUSES.has(run.status),
      {
        timeoutMs: params.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
        intervalMs: params.intervalMs ?? DEFAULT_SANDBOX_INTERVAL_MS,
        signal: params.signal,
        description: `Sandbox run ${params.sandboxRunId}`,
      },
    );
  }

  private async path(params: ModelVersionRef & RequestOptions) {
    return {
      organizationId: await this.context.organizationId(params),
      projectId: params.projectId,
      modelId: params.modelId,
      versionId: params.versionId,
    };
  }
}
