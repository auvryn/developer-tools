import { z } from 'zod';

/*
 * Shared input and output schemas. Inputs accept public IDs only (never
 * UUIDs); outputs are object envelopes whose resources come from the API as is
 * (`looseObject`: the SDK's types are the source of truth, not a copy here).
 */

const ALPHABET = '[0-9a-hjkmnp-tv-z]';

export const publicId = (prefix: string, what: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_${ALPHABET}{26}$`), `Must be a ${prefix}_… ID.`)
    .describe(`${what} (${prefix}_…)`);

export const projectId = publicId('prj', 'Project ID');
export const modelId = publicId('mdl', 'Model ID');
export const versionId = publicId('mdlver', 'Model version ID');
export const areaId = publicId('aoi', 'Area of interest ID');
export const estimateId = publicId('est', 'Cost estimate ID');
export const jobId = publicId('job', 'Execution job ID');
export const artifactId = publicId('rart', 'Result artifact ID');
export const sandboxRunId = publicId('sbox', 'Sandbox run ID');

/** Lists are paged: an agent asks for more only when it needs it. */
export const limit = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe('Items per page (1-100, default 20).');
export const cursor = z
  .string()
  .max(200)
  .optional()
  .describe('nextCursor from the previous page; omit for the first page.');

export const idempotencyKey = z
  .string()
  .regex(/^[!-~]{1,255}$/)
  .optional()
  .describe(
    'Optional. Reuse the same key to retry safely: the same key and request return the same resource (24 h). If omitted, the server generates one for this call and returns it.',
  );

/** Seconds a wait tool may block (kept short: MCP clients time out long calls). */
export const timeoutSeconds = z
  .number()
  .int()
  .min(1)
  .max(120)
  .default(30)
  .describe('How long to wait before returning (1-120 s, default 30). Call again to keep waiting.');

const position = z.array(z.number()).min(2).max(3);
const ring = z.array(position).min(4);
export const geometry = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) }),
    z.object({
      type: z.literal('MultiPolygon'),
      coordinates: z.array(z.array(ring).min(1)).min(1),
    }),
  ])
  .describe('GeoJSON Polygon or MultiPolygon in longitude/latitude (EPSG:4326). Rings are closed.');

/** An Auvryn resource as the API returns it (public IDs only). */
export const resource = z.looseObject({ id: z.string() });

export const page = (key: string) =>
  z.object({ [key]: z.array(resource), nextCursor: z.string().nullable() });
