import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AuvrynError } from '../errors.js';
import type {
  ExecutionRef,
  ExecutionResult,
  LedgerEntry,
  LedgerTotal,
  Page,
  PageOptions,
  ProjectRef,
  RequestOptions,
  ResultArtifact,
  UsageEvent,
  UsageTotal,
} from '../types.js';
import { type Context, iteratePages, query, read } from './context.js';

const PROJECT = '/api/v1/organizations/{organizationId}/projects/{projectId}' as const;
const RESULT = `${PROJECT}/execution-jobs/{jobId}/result` as const;

export interface ArtifactRef extends ExecutionRef {
  readonly artifactId: string;
}

/** A streamed artifact download. Consume or destroy `stream`. */
export interface ArtifactDownload {
  readonly stream: Readable;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  /** From `Content-Disposition`, when the API sends one. */
  readonly filename: string | null;
}

export interface SavedArtifact {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly artifact: ResultArtifact;
}

function filenameOf(disposition: string | null): string | null {
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Results of completed executions, owned and stored by Auvryn. */
export class Results {
  constructor(private readonly context: Context) {}

  /** The result of a job (`404 RESULT_NOT_FOUND` until it completed with one). */
  async get(params: ExecutionRef & RequestOptions): Promise<ExecutionResult> {
    const path = await this.path(params);
    return this.context.transport.call(
      (init) => this.context.transport.client.GET(RESULT, { params: { path }, ...init }),
      read(params),
    );
  }

  async getArtifact(params: ArtifactRef & RequestOptions): Promise<ResultArtifact> {
    const path = await this.path(params);
    return this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${RESULT}/artifacts/{artifactId}`, {
          params: { path: { ...path, artifactId: params.artifactId } },
          ...init,
        }),
      read(params),
    );
  }

  /** Streams an artifact's bytes (never buffered whole in memory). */
  async downloadArtifact(params: ArtifactRef & RequestOptions): Promise<ArtifactDownload> {
    const path = await this.path(params);
    let response: Response | undefined;
    const body = await this.context.transport.call(
      async (init) => {
        const result = await this.context.transport.client.GET(
          `${RESULT}/artifacts/{artifactId}/content`,
          {
            params: { path: { ...path, artifactId: params.artifactId } },
            parseAs: 'stream',
            ...init,
          },
        );
        response = result.response;
        return result;
      },
      { ...read(params), noTimeout: true },
    );
    const length = Number(response?.headers.get('content-length'));
    return {
      stream: Readable.fromWeb(body),
      contentType: response?.headers.get('content-type') ?? null,
      contentLength:
        Number.isFinite(length) && response?.headers.has('content-length') ? length : null,
      filename: filenameOf(response?.headers.get('content-disposition') ?? null),
    };
  }

  /**
   * Downloads an artifact to `path` and verifies its SHA-256 against the
   * artifact record. Writes to `<path>.part` first; on a mismatch the file is
   * removed and `ARTIFACT_CHECKSUM_MISMATCH` is thrown.
   */
  async saveArtifact(
    params: ArtifactRef & RequestOptions & { readonly path: string },
  ): Promise<SavedArtifact> {
    const artifact = await this.getArtifact(params);
    const download = await this.downloadArtifact(params);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const partial = `${params.path}.part`;
    try {
      await pipeline(
        download.stream,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            sizeBytes += chunk.length;
            callback(null, chunk);
          },
        }),
        createWriteStream(partial),
        ...(params.signal ? [{ signal: params.signal }] : []),
      );
      const sha256 = hash.digest('hex');
      if (sha256 !== artifact.sha256 || sizeBytes !== artifact.sizeBytes) {
        throw new AuvrynError({
          code: 'ARTIFACT_CHECKSUM_MISMATCH',
          message: `The downloaded artifact ${artifact.id} does not match its recorded size and SHA-256.`,
        });
      }
      await rename(partial, params.path);
      return { path: params.path, sizeBytes, sha256, artifact };
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  private async path(params: ExecutionRef & RequestOptions) {
    return {
      organizationId: await this.context.organizationId(params),
      projectId: params.projectId,
      jobId: params.jobId,
    };
  }
}

/** Usage events and ledger entries (consumption and provider cost estimates; not billing). */
export class Usage {
  constructor(private readonly context: Context) {}

  /** A page of usage events, plus exact totals per metric over every matching event. */
  async listEvents(
    params: ProjectRef & {
      readonly executionJobId?: string | undefined;
      readonly metric?: UsageEvent['metric'] | undefined;
    } & PageOptions,
  ): Promise<Page<UsageEvent> & { readonly totals: readonly UsageTotal[] }> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${PROJECT}/usage-events`, {
          params: {
            path: { organizationId, projectId: params.projectId },
            query: query({
              limit: params.limit,
              cursor: params.cursor,
              executionJobId: params.executionJobId,
              metric: params.metric,
            }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.usageEvents, nextCursor: body.nextCursor, totals: body.totals };
  }

  iterateEvents(
    params: ProjectRef & { readonly executionJobId?: string | undefined } & Omit<
        PageOptions,
        'cursor'
      >,
  ): AsyncGenerator<UsageEvent, void, undefined> {
    return iteratePages((cursor) => this.listEvents({ ...params, cursor }));
  }

  /** A page of ledger entries, plus totals per entry type, cost basis and currency. */
  async listLedger(
    params: ProjectRef & {
      readonly executionJobId?: string | undefined;
      readonly entryType?: LedgerEntry['entryType'] | undefined;
    } & PageOptions,
  ): Promise<Page<LedgerEntry> & { readonly totals: readonly LedgerTotal[] }> {
    const organizationId = await this.context.organizationId(params);
    const body = await this.context.transport.call(
      (init) =>
        this.context.transport.client.GET(`${PROJECT}/ledger-entries`, {
          params: {
            path: { organizationId, projectId: params.projectId },
            query: query({
              limit: params.limit,
              cursor: params.cursor,
              executionJobId: params.executionJobId,
              entryType: params.entryType,
            }),
          },
          ...init,
        }),
      read(params),
    );
    return { data: body.ledgerEntries, nextCursor: body.nextCursor, totals: body.totals };
  }

  iterateLedger(
    params: ProjectRef & { readonly executionJobId?: string | undefined } & Omit<
        PageOptions,
        'cursor'
      >,
  ): AsyncGenerator<LedgerEntry, void, undefined> {
    return iteratePages((cursor) => this.listLedger({ ...params, cursor }));
  }
}
