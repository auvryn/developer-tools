import type { operations } from './generated/openapi.js';

/*
 * Public resource types, derived from the generated OpenAPI types (never
 * re-declared by hand): if the API changes, regenerating changes these.
 */

/** As the transport returns it: tuples (e.g. GeoJSON positions) become plain arrays. */
type Plain<T> = T extends readonly (infer Element)[]
  ? Plain<Element>[]
  : T extends object
    ? { [Key in keyof T]: Plain<T[Key]> }
    : T;

type Json<
  Operation extends keyof operations,
  Status extends keyof operations[Operation]['responses'],
> = operations[Operation]['responses'][Status] extends {
  content: { 'application/json': infer Body };
}
  ? Plain<Body>
  : never;

type Item<List> = List extends readonly (infer Element)[] ? Element : never;

export type Me = Json<'getMe', 200>;
export type Organization = Json<'getOrganization', 200>;
export type Project = Json<'getProject', 200>;
export type Provider = Item<Json<'listProviders', 200>['providers']>;
/** The workspace's capabilities, and its limits with current usage (ADR-0032). */
export type WorkspaceEntitlements = Json<'getWorkspaceEntitlements', 200>;
/**
 * A workspace activation event (ADR-0034): what happened, who did it, to which
 * resource and when. API keys read activation events only, never audit events.
 */
export type WorkspaceEvent = Item<Json<'listWorkspaceEvents', 200>['events']>;
export type Model = Json<'getModel', 200>;
export type ModelVersion = Json<'getModelVersion', 200>;
export type ModelArtifact = Json<'getModelArtifact', 200>;
export type ModelValidation = Json<'getModelValidation', 200>;
export type SandboxRun = Json<'getSandboxRun', 200>;
export type AreaOfInterest = Json<'getAreaOfInterest', 200>;
export type CostEstimate = Json<'getCostEstimate', 200>;
export type ExecutionJob = Json<'getExecutionJob', 200>;
/** The created job, with how it was handed to the worker (`queued` or `deferred`). */
export type CreatedExecutionJob = Json<'createExecutionJob', 202>;
export type ExecutionResult = Json<'getExecutionJobResult', 200>;
export type ResultArtifact = Json<'getResultArtifact', 200>;
export type UsageEvent = Item<Json<'listUsageEvents', 200>['usageEvents']>;
export type UsageTotal = Item<Json<'listUsageEvents', 200>['totals']>;
export type LedgerEntry = Item<Json<'listLedgerEntries', 200>['ledgerEntries']>;
export type LedgerTotal = Item<Json<'listLedgerEntries', 200>['totals']>;

export type ExecutionJobStatus = ExecutionJob['status'];
export type ModelValidationStatus = ModelValidation['status'];
export type SandboxRunStatus = SandboxRun['status'];

/** GeoJSON accepted for areas of interest (EPSG:4326 longitude/latitude). */
export type Position = readonly [number, number] | readonly number[];
export type AreaGeometry =
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly Position[])[] }
  | {
      readonly type: 'MultiPolygon';
      readonly coordinates: readonly (readonly (readonly Position[])[])[];
    };

/** One page of a list. Pass `nextCursor` back as `cursor`; `null` means the last page. */
export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

/** Options every call accepts. */
export interface RequestOptions {
  /** Cancels the call (and, for `wait…` helpers, the polling). */
  readonly signal?: AbortSignal | undefined;
  /** Your own request ID (`[A-Za-z0-9_-]{1,128}`), echoed by the API in `X-Request-Id`. */
  readonly requestId?: string | undefined;
}

/** Options of creates that support `Idempotency-Key`. */
export interface IdempotentOptions extends RequestOptions {
  /**
   * Makes retries safe: the same key and request return the same resource for
   * 24 hours. Generate one with `Auvryn.idempotencyKey()` and reuse it when you
   * retry. Without it, the SDK never retries the create.
   */
  readonly idempotencyKey?: string | undefined;
}

/** Bounds of a `wait…` helper. Every wait ends: `timeoutMs` is always finite. */
export interface WaitOptions extends RequestOptions {
  readonly timeoutMs?: number | undefined;
  readonly intervalMs?: number | undefined;
}

export interface PageOptions extends RequestOptions {
  /** 1–100 (default 100). */
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ProjectRef {
  readonly projectId: string;
}

export interface ModelVersionRef extends ProjectRef {
  readonly modelId: string;
  readonly versionId: string;
}

export interface ExecutionRef extends ProjectRef {
  readonly jobId: string;
}
