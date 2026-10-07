import { z } from 'zod';

import { LocalError } from '../errors.js';
import { resolveWritableFile } from '../files.js';
import { artifactId, jobId, projectId, resource } from '../schemas.js';
import { type AnyToolSpec, defineTool } from '../tool.js';

/*
 * Results: metadata, a bounded text preview for textual artifacts, and a
 * download to a local file inside AUVRYN_MCP_FILE_ROOT. Artifact bytes never
 * enter the agent's context beyond the preview limit.
 */

export const PREVIEW_DEFAULT_BYTES = 16 * 1024;
export const PREVIEW_MAX_BYTES = 64 * 1024;

const TEXTUAL =
  /^(text\/[a-z0-9.+-]+|application\/([a-z0-9.-]+\+)?(json|xml|csv|x-ndjson|geo\+json))(;|$)/i;

/** Whether an artifact's media type can be previewed as text. */
export function isPreviewable(mediaType: string): boolean {
  return TEXTUAL.test(mediaType.trim());
}

/** Reads at most `maxBytes` from a stream, then stops it. */
async function readPrefix(
  stream: AsyncIterable<unknown> & { destroy(): void },
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    if (size + buffer.length > maxBytes) {
      chunks.push(buffer.subarray(0, maxBytes - size));
      truncated = true;
      break;
    }
    chunks.push(buffer);
    size += buffer.length;
  }
  stream.destroy();
  return { bytes: Buffer.concat(chunks), truncated };
}

export const resultTools: readonly AnyToolSpec[] = [
  defineTool({
    name: 'get_result',
    title: 'Get execution result',
    description:
      'Returns the result of a completed execution: provenance (provider, provider execution, completion time), a summary (artifact count, total size, kinds) and the artifact list (ID, name, kind, media type, size, SHA-256, previewable). RESULT_NOT_FOUND until the execution completed. Content is not included: use preview_result_artifact (small text) or download_result_artifact.',
    safety: 'read',
    scope: 'results:read',
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: z.object({ projectId, jobId }),
    output: z.object({ result: resource, artifacts: z.array(resource) }),
    run: async (args, { auvryn, signal }) => {
      const result = await auvryn.results.get({ ...args, signal });
      const { artifacts, ...rest } = result;
      return {
        result: rest,
        artifacts: artifacts.map((artifact) => ({
          ...artifact,
          previewable: isPreviewable(artifact.mediaType),
        })),
      };
    },
  }),

  defineTool({
    name: 'preview_result_artifact',
    title: 'Preview result artifact',
    description: `Returns the beginning of a textual result artifact (JSON, GeoJSON, CSV, text) as UTF-8, at most maxBytes (default ${String(PREVIEW_DEFAULT_BYTES)}, max ${String(PREVIEW_MAX_BYTES)}), with truncated=true when there is more. Binary artifacts (images, tensors) are refused (UNSUPPORTED_PREVIEW): download them instead.`,
    safety: 'read',
    scope: 'results:read',
    annotations: { readOnlyHint: true, openWorldHint: false },
    input: z.object({
      projectId,
      jobId,
      artifactId,
      maxBytes: z.number().int().min(1).max(PREVIEW_MAX_BYTES).default(PREVIEW_DEFAULT_BYTES),
    }),
    output: z.object({
      artifact: resource,
      preview: z.string(),
      previewBytes: z.number(),
      truncated: z.boolean(),
    }),
    run: async ({ maxBytes, ...ref }, { auvryn, signal }) => {
      const artifact = await auvryn.results.getArtifact({ ...ref, signal });
      if (!isPreviewable(artifact.mediaType)) {
        throw new LocalError(
          'UNSUPPORTED_PREVIEW',
          `Artifact ${artifact.id} is ${artifact.mediaType}, not text; use download_result_artifact.`,
        );
      }
      const download = await auvryn.results.downloadArtifact({ ...ref, signal });
      const { bytes, truncated } = await readPrefix(download.stream, maxBytes);
      return {
        artifact,
        preview: bytes.toString('utf8'),
        previewBytes: bytes.length,
        truncated: truncated || bytes.length < artifact.sizeBytes,
      };
    },
  }),

  defineTool({
    name: 'download_result_artifact',
    title: 'Download result artifact',
    description:
      'Downloads a result artifact to a file on this machine, streamed and verified against its SHA-256. Precondition: local file access enabled (AUVRYN_MCP_FILE_ROOT); destinationPath is relative to that root (or absolute inside it) and its directory must exist. Never replaces an existing file unless overwrite is true, and never writes through a symbolic link. Returns { path, sizeBytes, sha256, artifactId } — not the content.',
    safety: 'local-file',
    scope: 'results:read',
    annotations: {
      readOnlyHint: false,
      // With overwrite: true it replaces an existing local file.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: z.object({
      projectId,
      jobId,
      artifactId,
      destinationPath: z
        .string()
        .min(1)
        .max(1024)
        .describe('File path relative to AUVRYN_MCP_FILE_ROOT (or absolute inside it).'),
      overwrite: z.boolean().default(false).describe('Replace an existing file (default false).'),
    }),
    output: z.object({
      path: z.string(),
      sizeBytes: z.number(),
      sha256: z.string(),
      artifactId: z.string(),
    }),
    run: async ({ destinationPath, overwrite, ...ref }, { auvryn, config, signal }) => {
      const path = await resolveWritableFile(config.fileRoot, destinationPath, overwrite);
      const saved = await auvryn.results.saveArtifact({ ...ref, path, signal });
      return {
        path: saved.path,
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        artifactId: saved.artifact.id,
      };
    },
  }),
];
