import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuvrynError, WaitTimeoutError } from '../src/index.js';
import { JOBS_PATH, ORG, PROJECT, apiError, fakeClient, json } from './support.js';

const VERSION_PATH = `/api/v1/organizations/${ORG}/projects/${PROJECT}/models/mdl_1/versions/mdlver_1`;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('polling', () => {
  it('waits until a terminal status and returns the job', async () => {
    const statuses = ['scheduled', 'running', 'processing', 'completed'];
    const { client, calls } = fakeClient(() => json({ id: 'job_1', status: statuses.shift() }));
    const job = await client.executions.wait({
      projectId: PROJECT,
      jobId: 'job_1',
      intervalMs: 250,
      timeoutMs: 10_000,
    });
    expect(job.status).toBe('completed');
    expect(calls(`${JOBS_PATH}/job_1`)).toHaveLength(4);
  });

  it('stops at its timeout with the last state, and requires a finite timeout', async () => {
    const { client } = fakeClient(() => json({ id: 'job_1', status: 'running' }));
    const error = await client.executions
      .wait({ projectId: PROJECT, jobId: 'job_1', intervalMs: 250, timeoutMs: 600 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ code: 'WAIT_TIMEOUT', last: { status: 'running' } });
    for (const timeoutMs of [Infinity, 0, -1, Number.NaN]) {
      await expect(
        client.executions.wait({ projectId: PROJECT, jobId: 'job_1', timeoutMs }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    await expect(
      client.executions.wait({ projectId: PROJECT, jobId: 'job_1', intervalMs: 10 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('is cancelled by an AbortSignal', async () => {
    const { client } = fakeClient(() => json({ id: 'job_1', status: 'running' }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(
      client.executions.wait({
        projectId: PROJECT,
        jobId: 'job_1',
        intervalMs: 250,
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats invalid as a final validation state', async () => {
    const { client } = fakeClient(() => json({ id: 'val_1', status: 'invalid' }));
    await expect(
      client.models.waitForValidation({
        projectId: PROJECT,
        modelId: 'mdl_1',
        versionId: 'mdlver_1',
        intervalMs: 250,
      }),
    ).resolves.toMatchObject({ status: 'invalid' });
  });
});

describe('model upload', () => {
  let server: Server;
  let storageUrl = '';
  const received: { headers: Record<string, unknown>; body: Buffer }[] = [];
  let storageStatus = 200;
  let directory = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(storageStatus).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    storageUrl = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/bucket/models/key?X-Signed=1`;
    directory = await mkdtemp(join(tmpdir(), 'auvryn-sdk-'));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  function storageApi() {
    return fakeClient(async (request, url) => {
      if (url.pathname === `${VERSION_PATH}/artifact/upload`) {
        const body = (await request.json()) as Record<string, unknown>;
        return json({
          artifact: { id: 'art_1', status: 'pending', ...body },
          upload: {
            url: storageUrl,
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            expiresAt: '2026-10-01T12:10:00.000Z',
          },
        });
      }
      if (url.pathname === `${VERSION_PATH}/artifact/complete`) {
        return json({ id: 'art_1', status: 'uploaded' });
      }
      if (url.pathname.endsWith('/versions')) {
        return json({ id: 'mdlver_1', version: 1 }, 201);
      }
      return apiError(404, 'NOT_FOUND');
    });
  }

  it('computes size and SHA-256 of a file path, PUTs it with Content-Length, then completes', async () => {
    const bytes = Buffer.from('not really onnx, but bytes all the same');
    const file = join(directory, 'model.onnx');
    await writeFile(file, bytes);
    const { client, calls } = storageApi();
    const result = await client.models.uploadVersion({
      projectId: PROJECT,
      modelId: 'mdl_1',
      file,
    });
    expect(result).toMatchObject({ version: { id: 'mdlver_1' }, artifact: { status: 'uploaded' } });
    expect(await calls(`${VERSION_PATH}/artifact/upload`)[0]?.json()).toEqual({
      filename: 'model.onnx',
      sizeBytes: bytes.length,
      checksumSha256: sha256(bytes),
    });
    const put = received.at(-1);
    expect(put?.body.equals(bytes)).toBe(true);
    expect(put?.headers['content-length']).toBe(String(bytes.length));
    expect(put?.headers['content-type']).toBe('application/octet-stream');
    expect(calls(`${VERSION_PATH}/artifact/complete`)).toHaveLength(1);
  });

  it('accepts bytes with a filename, and requires the filename', async () => {
    const { client } = storageApi();
    const ref = { projectId: PROJECT, modelId: 'mdl_1', versionId: 'mdlver_1' };
    await expect(
      client.models.uploadArtifact({ ...ref, file: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await client.models.uploadArtifact({
      ...ref,
      file: new Uint8Array([1, 2, 3]),
      filename: 'm.onnx',
    });
    expect(received.at(-1)?.body.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('reports a refused storage upload without the signed URL, and does not complete', async () => {
    storageStatus = 403;
    try {
      const { client, calls } = storageApi();
      const error = await client.models
        .uploadArtifact({
          projectId: PROJECT,
          modelId: 'mdl_1',
          versionId: 'mdlver_1',
          file: new Uint8Array([9]),
          filename: 'm.onnx',
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'UPLOAD_FAILED', status: 403 });
      expect(String((error as AuvrynError).message)).not.toContain('X-Signed');
      expect(calls(`${VERSION_PATH}/artifact/complete`)).toHaveLength(0);
    } finally {
      storageStatus = 200;
    }
  });
});

describe('artifact downloads', () => {
  const content = Buffer.alloc(3 * 1024 * 1024, 7);
  const RESULT = `${JOBS_PATH}/job_1/result/artifacts/rart_1`;
  let directory = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'auvryn-sdk-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function resultApi(recorded: string) {
    return fakeClient((_request, url) => {
      if (url.pathname === `${RESULT}/content`) {
        // Streamed in 64 KiB chunks, never as one buffer.
        const chunks = Array.from({ length: content.length / 65_536 }, (_, i) =>
          content.subarray(i * 65_536, (i + 1) * 65_536),
        );
        return new Response(Readable.toWeb(Readable.from(chunks)) as ReadableStream, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(content.length),
            'content-disposition': 'attachment; filename="detections.bin"',
          },
        });
      }
      return json({
        id: 'rart_1',
        name: 'detections.bin',
        sizeBytes: content.length,
        sha256: recorded,
      });
    });
  }

  it('streams the content with its metadata', async () => {
    const { client } = resultApi(sha256(content));
    const download = await client.results.downloadArtifact({
      projectId: PROJECT,
      jobId: 'job_1',
      artifactId: 'rart_1',
    });
    expect(download).toMatchObject({
      contentType: 'application/octet-stream',
      contentLength: content.length,
      filename: 'detections.bin',
    });
    let size = 0;
    for await (const chunk of download.stream) {
      size += (chunk as Buffer).length;
    }
    expect(size).toBe(content.length);
  });

  it('saves to a file and verifies the SHA-256', async () => {
    const { client } = resultApi(sha256(content));
    const path = join(directory, 'out.bin');
    const saved = await client.results.saveArtifact({
      projectId: PROJECT,
      jobId: 'job_1',
      artifactId: 'rart_1',
      path,
    });
    expect(saved).toMatchObject({ path, sizeBytes: content.length, sha256: sha256(content) });
    expect(sha256(await readFile(path))).toBe(sha256(content));
  });

  it('refuses a mismatching download and leaves no file behind', async () => {
    const { client } = resultApi('0'.repeat(64));
    const path = join(directory, 'bad.bin');
    await expect(
      client.results.saveArtifact({
        projectId: PROJECT,
        jobId: 'job_1',
        artifactId: 'rart_1',
        path,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CHECKSUM_MISMATCH' });
    await expect(stat(path)).rejects.toThrow();
    await expect(stat(`${path}.part`)).rejects.toThrow();
  });
});

describe('sample workload (F036)', () => {
  const SAMPLE_PATH = `/api/v1/organizations/${ORG}/projects/${PROJECT}/sample-workloads`;

  it('starts it with an empty body (no model, no provider), safely retried only with a key', async () => {
    let attempts = 0;
    const { client, calls } = fakeClient((request, url) => {
      if (url.pathname !== SAMPLE_PATH || request.method !== 'POST') {
        return json({}, 500);
      }
      attempts += 1;
      return attempts === 1
        ? apiError(503, 'SERVICE_UNAVAILABLE')
        : json({ id: 'job_1', status: 'created', providerId: 'sample', dispatch: 'queued' }, 202);
    });
    const job = await client.executions.createSample({ projectId: PROJECT, idempotencyKey: 'k1' });
    expect(job).toMatchObject({ id: 'job_1', providerId: 'sample' });
    const sent = calls(SAMPLE_PATH);
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.headers.get('Idempotency-Key')).toBe('k1');
      expect(await request.json()).toEqual({});
    }

    // Without a key, a failed create is never repeated (it could start a second run).
    attempts = 0;
    const once = fakeClient(() => apiError(503, 'SERVICE_UNAVAILABLE'));
    await expect(once.client.executions.createSample({ projectId: PROJECT })).rejects.toMatchObject(
      {
        status: 503,
      },
    );
    expect(once.calls(SAMPLE_PATH)).toHaveLength(1);
    expect(once.calls(SAMPLE_PATH)[0]?.headers.get('Idempotency-Key')).toBeNull();
  });
});
