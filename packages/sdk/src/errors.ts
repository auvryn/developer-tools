import type { components } from './generated/openapi.js';

/**
 * Machine-readable error codes of the Developer API (from its OpenAPI
 * description), plus the SDK's own codes. Unknown future codes are plain strings.
 */
export type ApiErrorCode = components['schemas']['ApiError']['error']['code'];

/** Codes raised by the SDK itself, before or around an HTTP call. */
export type SdkErrorCode =
  | 'API_KEY_REQUIRED'
  | 'API_KEY_INVALID_FORMAT'
  | 'INVALID_BASE_URL'
  | 'INVALID_ARGUMENT'
  | 'ORGANIZATION_UNAVAILABLE'
  | 'CONNECTION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'UPLOAD_FAILED'
  | 'ARTIFACT_CHECKSUM_MISMATCH'
  | 'WAIT_TIMEOUT'
  | 'UNEXPECTED_RESPONSE';

export type ErrorCode = ApiErrorCode | SdkErrorCode | (string & {});

export interface AuvrynErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
  readonly status?: number | undefined;
  readonly requestId?: string | undefined;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Base class of every error the SDK throws. Branch on `code` (stable and
 * machine-readable), never on `message`. Errors never contain the API key,
 * request headers or signed storage URLs.
 */
export class AuvrynError extends Error {
  readonly code: ErrorCode;
  /** HTTP status, when the error came from an HTTP response. */
  readonly status: number | undefined;
  /** The API's request ID (`X-Request-Id`): include it when asking for support. */
  readonly requestId: string | undefined;
  /** Structured, safe details from the API (e.g. `issues`, `requiredScope`). */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: AuvrynErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status ?? null,
      requestId: this.requestId ?? null,
      details: this.details,
    };
  }
}

/** The API answered with an error (any status without a more specific class). */
export class ApiError extends AuvrynError {
  declare readonly status: number;
}

/** `401`: missing, malformed, unknown, revoked or expired API key. */
export class AuthenticationError extends ApiError {}

/**
 * `403`: the API key lacks the operation's scope (`INSUFFICIENT_SCOPE`), or its
 * creator's role does not allow it (`INSUFFICIENT_ROLE`).
 */
export class PermissionError extends ApiError {}

/**
 * `403 ENTITLEMENT_REQUIRED` / `ENTITLEMENT_EXPIRED`: the role allows the
 * operation, but the workspace does not have the capability
 * (`details.capability`). Only Auvryn can enable it; retrying does not help.
 */
export class EntitlementError extends PermissionError {}

/** `404`: not found, or not visible to this key (indistinguishable by design). */
export class NotFoundError extends ApiError {}

/** `409`: conflicts with the current state, or `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_IN_PROGRESS`. */
export class ConflictError extends ApiError {}

/**
 * `409 WORKSPACE_LIMIT_REACHED` / `CONCURRENT_RUN_LIMIT_REACHED`: a workspace
 * limit is reached (`details.limit`, `details.used`, `details.max`). Runs in
 * progress free their slot when they finish; other limits are raised by Auvryn.
 */
export class LimitReachedError extends ConflictError {}

/** `400` / `422`: the request or its content was rejected (`details.issues` when available). */
export class ValidationError extends ApiError {}

/**
 * `429 RATE_LIMITED`. The SDK never sleeps on your behalf: wait
 * `retryAfterSeconds` and retry if appropriate.
 */
export class RateLimitError extends ApiError {
  readonly retryAfterSeconds: number;

  constructor(options: AuvrynErrorOptions & { readonly retryAfterSeconds: number }) {
    super(options);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterSeconds: this.retryAfterSeconds };
  }
}

/** The API could not be reached, or did not answer in time (`CONNECTION_FAILED`, `REQUEST_TIMEOUT`). */
export class ConnectionError extends AuvrynError {}

/** A `wait…` helper reached its timeout; `last` is the last state read. */
export class WaitTimeoutError<T = unknown> extends AuvrynError {
  readonly last: T | undefined;

  constructor(message: string, last: T | undefined) {
    super({ code: 'WAIT_TIMEOUT', message });
    this.last = last;
  }
}

/** Maps an API error response to the matching error class. */
export function apiErrorFromResponse(status: number, body: unknown, headers: Headers): ApiError {
  const error =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: Record<string, unknown> }).error
      : undefined;
  const options: AuvrynErrorOptions = {
    code: typeof error?.['code'] === 'string' ? error['code'] : 'UNEXPECTED_RESPONSE',
    message:
      typeof error?.['message'] === 'string'
        ? error['message']
        : `The API answered HTTP ${String(status)} without an error body.`,
    status,
    requestId:
      (typeof error?.['requestId'] === 'string' ? error['requestId'] : undefined) ??
      headers.get('x-request-id') ??
      undefined,
    details:
      typeof error?.['details'] === 'object' && error['details'] !== null
        ? (error['details'] as Record<string, unknown>)
        : {},
  };
  switch (status) {
    case 400:
    case 422:
      return new ValidationError(options);
    case 401:
      return new AuthenticationError(options);
    case 403:
      return options.code === 'ENTITLEMENT_REQUIRED' || options.code === 'ENTITLEMENT_EXPIRED'
        ? new EntitlementError(options)
        : new PermissionError(options);
    case 404:
      return new NotFoundError(options);
    case 409:
      return options.code === 'WORKSPACE_LIMIT_REACHED' ||
        options.code === 'CONCURRENT_RUN_LIMIT_REACHED' ||
        options.code === 'SAMPLE_RUN_LIMIT_REACHED'
        ? new LimitReachedError(options)
        : new ConflictError(options);
    case 429: {
      const header = Number(headers.get('retry-after'));
      return new RateLimitError({
        ...options,
        retryAfterSeconds: Number.isFinite(header) && header > 0 ? header : 1,
      });
    }
    default:
      return new ApiError(options);
  }
}
