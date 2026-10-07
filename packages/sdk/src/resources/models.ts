import { type FileInput, prepareFile, putSignedUpload } from '../files.js';
import type { operations } from '../generated/openapi.js';
import { pollUntil } from '../poll.js';
import type {
  IdempotentOptions,
  Model,
  ModelArtifact,
  ModelValidation,
  ModelVersion,
  ModelVersionRef,
  Page,
  PageOptions,
  ProjectRef,
  RequestOptions,
  WaitOptions,
} from '../types.js';
import { type Context, iteratePages, query, read, singlePage, write } from './context.js';

type CreateModelBody = operations['createModel']['requestBody']['content']['application/json'];
type CreateVersionBody =
  operations['createModelVersion']['requestBody']['content']['application/json'];

/** Validation states after which nothing changes without a new request. */
const FINAL_VALIDATION_STATUSES: ReadonlySet<ModelValidation['status']> = new Set([
  'valid',
  'invalid',
  'failed',
]);

export const DEFAULT_VALIDATION_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_VALIDATION_INTERVAL_MS = 2_000;

const MODELS = '/api/v1/organizations/{organizationId}/projects/{projectId}/models' as const;
const MODEL = `${MODELS}/{modelId}` as const;
const VERSIONS = `${MODEL}/versions` as const;
const VERSION = `${VERSIONS}/{versionId}` as const;

export interface UploadOptions extends RequestOptions {
  /** A path to the `.onnx` file, or its bytes (then `filename` is required). */
  readonly file: FileInput;
  readonly filename?: string | undefined;
}

/**
 * Models, their immutable versions, model files (signed upload) and
 * validation. Every method maps to Developer API calls; the SDK adds the
 * upload plumbing (size, SHA-256, signed `PUT`) and bounded waits.
 */
export class Models {
  constructor(private readonly context: Context) {}

  async list(params: ProjectRef & PageOptions): Promise<Page<Model>> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(MODELS, {
          params: {
            path: { organizationId, projectId: params.projectId },
            query: query({ limit: params.limit, cursor: params.cursor }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.models, nextCursor: body.nextCursor };
  }

  /** Every model of the project, newest first, fetching pages as needed. */
  iterate(
    params: ProjectRef & Omit<PageOptions, 'cursor'>,
  ): AsyncGenerator<Model, void, undefined> {
    return iteratePages((cursor) => this.list({ ...params, cursor }));
  }

  async get(params: ProjectRef & { readonly modelId: string } & RequestOptions): Promise<Model> {
    const organizationId = await this.context.organizationId(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(MODEL, {
          params: {
            path: { organizationId, projectId: params.projectId, modelId: params.modelId },
          },
          ...init,
        }),
      read(params),
    );
  }

  async create(
    params: ProjectRef & {
      readonly name: string;
      readonly slug?: string | undefined;
      readonly description?: string | null | undefined;
    } & IdempotentOptions,
  ): Promise<Model> {
    const organizationId = await this.context.organizationId(params);
    const body: CreateModelBody = query({
      name: params.name,
      slug: params.slug,
      description: params.description,
    }) as CreateModelBody;
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(MODELS, {
          params: { path: { organizationId, projectId: params.projectId } },
          body,
          ...init,
        }),
      write(params),
    );
  }

  /** Versions of a model, highest first (at most 100; not paginated by the API). */
  async listVersions(
    params: ProjectRef & { readonly modelId: string } & RequestOptions,
  ): Promise<Page<ModelVersion>> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(VERSIONS, {
          params: {
            path: { organizationId, projectId: params.projectId, modelId: params.modelId },
          },
          ...init,
        }),
      read(params),
    );
    return singlePage(body.versions);
  }

  async getVersion(params: ModelVersionRef & RequestOptions): Promise<ModelVersion> {
    const path = await this.versionPath(params);
    return this.context.transport.call(
      (init) => this.context.transport.client.GET(VERSION, { params: { path }, ...init }),
      read(params),
    );
  }

  /** Creates the next version (numbered by the API). `format` defaults to `onnx`. */
  async createVersion(
    params: ProjectRef & {
      readonly modelId: string;
      readonly format?: string | undefined;
      readonly framework?: CreateVersionBody['framework'];
      readonly description?: string | null | undefined;
    } & IdempotentOptions,
  ): Promise<ModelVersion> {
    const organizationId = await this.context.organizationId(params);
    const body = query({
      format: params.format ?? 'onnx',
      framework: params.framework,
      description: params.description,
    }) as CreateVersionBody;
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(VERSIONS, {
          params: {
            path: { organizationId, projectId: params.projectId, modelId: params.modelId },
          },
          body,
          ...init,
        }),
      write(params),
    );
  }

  /** The version's model file record (`404 MODEL_ARTIFACT_NOT_FOUND` before an upload was requested). */
  async getArtifact(params: ModelVersionRef & RequestOptions): Promise<ModelArtifact> {
    const path = await this.versionPath(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${VERSION}/artifact`, { params: { path }, ...init }),
      read(params),
    );
  }

  /**
   * Uploads the version's model file: computes size and SHA-256, requests a
   * signed upload, sends the file straight to storage, then asks the API to
   * verify it. Any failure is thrown as is (nothing is retried silently).
   */
  async uploadArtifact(params: ModelVersionRef & UploadOptions): Promise<ModelArtifact> {
    const file = await prepareFile(params.file, params.filename);
    const path = await this.versionPath(params);
    const { upload } = await this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(`${VERSION}/artifact/upload`, {
          params: { path },
          body: { filename: file.filename, sizeBytes: file.sizeBytes, checksumSha256: file.sha256 },
          ...init,
        }),
      write(params),
    );
    await putSignedUpload(upload, file, params.signal);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(`${VERSION}/artifact/complete`, {
          params: { path },
          ...init,
        }),
      write(params),
    );
  }

  /**
   * Creates a version and uploads its file (`createVersion` + `uploadArtifact`).
   * It does not validate: call `validate` next.
   */
  async uploadVersion(
    params: ProjectRef & {
      readonly modelId: string;
      readonly format?: string | undefined;
      readonly framework?: CreateVersionBody['framework'];
      readonly description?: string | null | undefined;
    } & UploadOptions &
      IdempotentOptions,
  ): Promise<{ readonly version: ModelVersion; readonly artifact: ModelArtifact }> {
    const version = await this.createVersion(params);
    const artifact = await this.uploadArtifact({
      projectId: params.projectId,
      modelId: params.modelId,
      versionId: version.id,
      file: params.file,
      filename: params.filename,
      signal: params.signal,
      requestId: params.requestId,
    });
    return { version, artifact };
  }

  /** Requests validation of the uploaded file (the worker validates asynchronously). */
  async validate(params: ModelVersionRef & RequestOptions): Promise<ModelValidation> {
    const path = await this.versionPath(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.POST(`${VERSION}/artifact/validation`, {
          params: { path },
          ...init,
        }),
      write(params),
    );
  }

  async getValidation(params: ModelVersionRef & RequestOptions): Promise<ModelValidation> {
    const path = await this.versionPath(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${VERSION}/artifact/validation`, {
          params: { path },
          ...init,
        }),
      read(params),
    );
  }

  /**
   * Polls until the validation is `valid`, `invalid` or `failed` and returns
   * it (check `status`). Default timeout 5 minutes, interval 2 seconds.
   */
  waitForValidation(params: ModelVersionRef & WaitOptions): Promise<ModelValidation> {
    return pollUntil(
      () => this.getValidation(params),
      (validation) => FINAL_VALIDATION_STATUSES.has(validation.status),
      {
        timeoutMs: params.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
        intervalMs: params.intervalMs ?? DEFAULT_VALIDATION_INTERVAL_MS,
        signal: params.signal,
        description: `Validation of model version ${params.versionId}`,
      },
    );
  }

  private async versionPath(params: ModelVersionRef & RequestOptions) {
    const organizationId = await this.context.organizationId(params);
    return {
      organizationId,
      projectId: params.projectId,
      modelId: params.modelId,
      versionId: params.versionId,
    };
  }
}
