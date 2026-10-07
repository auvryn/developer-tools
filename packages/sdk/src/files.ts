import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AuvrynError } from './errors.js';

/*
 * Model files for upload: size and SHA-256 computed by the SDK (streaming, so a
 * large file is never held in memory), then sent straight to object storage
 * with the signed upload the API returned.
 */

/** A file path, or the bytes of the file (then `filename` is required). */
export type FileInput = string | Uint8Array;

export interface PreparedFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  open(): Readable;
}

export async function prepareFile(input: FileInput, filename?: string): Promise<PreparedFile> {
  if (typeof input === 'string') {
    const info = await stat(input).catch(() => null);
    if (!info?.isFile()) {
      throw new AuvrynError({ code: 'INVALID_ARGUMENT', message: 'file must be a readable file.' });
    }
    const hash = createHash('sha256');
    await pipeline(createReadStream(input), hash);
    return {
      filename: filename ?? basename(input),
      sizeBytes: info.size,
      sha256: hash.digest('hex'),
      open: () => createReadStream(input),
    };
  }
  if (filename === undefined || filename === '') {
    throw new AuvrynError({
      code: 'INVALID_ARGUMENT',
      message: 'filename is required when the file is given as bytes.',
    });
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return {
    filename,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    open: () => Readable.from([bytes]),
  };
}

/**
 * `PUT`s the file to a signed storage URL with exactly the signed headers and
 * an explicit `Content-Length` (signed uploads do not accept chunked bodies).
 * Errors never include the signed URL.
 */
export async function putSignedUpload(
  upload: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
  file: PreparedFile,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(upload.url);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const status = await new Promise<number>((resolve, reject) => {
    const request = send(
      url,
      {
        method: 'PUT',
        headers: { ...upload.headers, 'Content-Length': String(file.sizeBytes) },
        ...(signal ? { signal } : {}),
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
        response.once('error', reject);
      },
    );
    request.once('error', (error) => {
      reject(
        signal?.aborted
          ? (signal.reason as Error)
          : new AuvrynError({
              code: 'UPLOAD_FAILED',
              message: `Could not upload the file to storage (${error.name}).`,
            }),
      );
    });
    pipeline(file.open(), request).catch(() => undefined);
  });
  if (status < 200 || status >= 300) {
    throw new AuvrynError({
      code: 'UPLOAD_FAILED',
      message: `Storage refused the upload (HTTP ${String(status)}). Request a new upload and try again.`,
      status,
    });
  }
}
