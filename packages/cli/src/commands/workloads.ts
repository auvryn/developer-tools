import { readFile } from 'node:fs/promises';

import type { AreaGeometry, CostEstimate, ExecutionJob, ExecutionJobStatus } from '@auvryn/sdk';
import type { Command } from 'commander';

import { type Context, UnsuccessfulOutcome, UsageError } from '../context.js';
import { details, money, moreHint, table } from '../format.js';
import { type Define, optional, required } from '../program.js';
import {
  idempotency,
  idempotencyKeyOf,
  readPage,
  timeoutOf,
  withPaging,
  withWait,
} from './shared.js';

const EXECUTION_TIMEOUT = '30m';

function estimateDetails(estimate: CostEstimate): string {
  return details([
    ['Estimate', estimate.id],
    ['Estimated cost', money(estimate.amountMinor, estimate.currency)],
    ['Provider', estimate.providerId],
    ['Model version', estimate.modelVersionId],
    ['Area', estimate.areaOfInterestId],
    ['Expires', estimate.expiresAt],
    ['Created', estimate.createdAt],
  ]);
}

function jobDetails(job: ExecutionJob): string {
  return details([
    ['Execution', job.id],
    ['Status', job.status],
    ['Provider', job.providerId],
    ['Model version', job.modelVersionId],
    ['Estimate', job.costEstimateId],
    ['Failure', job.failure ? `${job.failure.code}: ${job.failure.message}` : null],
    ['Created', job.createdAt],
    ['Completed', job.completedAt],
    // Provenance and telemetry, once the job is final (--json prints all of it).
    ['Environment', job.telemetry?.provenance.executionEnvironment ?? null],
    [
      'Simulated',
      job.telemetry?.provenance.simulated === undefined
        ? null
        : job.telemetry.provenance.simulated
          ? 'yes'
          : 'no',
    ],
    [
      'Telemetry',
      job.telemetry ? `${String(job.telemetry.metrics.length)} metrics (--json for all)` : null,
    ],
  ]);
}

async function waitForJob(
  context: Context,
  jobId: string,
  options: Record<string, unknown>,
): Promise<void> {
  const timeoutMs = timeoutOf(options, EXECUTION_TIMEOUT);
  context.note(`Waiting for execution ${jobId}...`);
  const job = await context
    .client()
    .executions.wait({ projectId: context.projectId(), jobId, timeoutMs });
  context.print(job, () => jobDetails(job));
  if (job.status !== 'completed') {
    throw new UnsuccessfulOutcome();
  }
}

async function readGeometry(path: string): Promise<AreaGeometry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new UsageError(`--geojson ${path} is not a readable JSON file.`);
  }
  // A Feature or a one-feature FeatureCollection is unwrapped; the API validates the geometry.
  let geometry = parsed as Record<string, unknown> | null;
  if (geometry?.['type'] === 'FeatureCollection') {
    const features = geometry['features'];
    if (!Array.isArray(features) || features.length !== 1) {
      throw new UsageError('A FeatureCollection must contain exactly one feature.');
    }
    geometry = features[0] as Record<string, unknown>;
  }
  if (geometry?.['type'] === 'Feature') {
    geometry = geometry['geometry'] as Record<string, unknown> | null;
  }
  if (geometry?.['type'] !== 'Polygon' && geometry?.['type'] !== 'MultiPolygon') {
    throw new UsageError('--geojson must contain a Polygon or MultiPolygon geometry.');
  }
  return geometry as unknown as AreaGeometry;
}

/** `areas …`, `estimates …`, `executions …`. */
export function registerWorkloadCommands(program: Command, define: Define): void {
  const areas = program.command('areas').description('Areas of interest (GeoJSON, EPSG:4326)');

  withPaging(areas.command('list').description('List areas of interest (newest first)')).action(
    define(async (context, options) => {
      const client = context.client();
      const projectId = context.projectId();
      const page = await readPage(
        options,
        (paging) => client.areas.list({ projectId, ...paging }),
        (paging) => client.areas.iterate({ projectId, ...paging }),
      );
      context.print(
        page,
        () =>
          table(
            page.data.map((area) => ({ ...area, km2: (area.areaSquareMeters / 1e6).toFixed(3) })),
            [
              ['ID', 'id'],
              ['Name', 'name'],
              ['Area (km²)', 'km2'],
              ['Created', 'createdAt'],
            ],
            'No areas of interest.',
          ) + moreHint(page.nextCursor),
      );
    }),
  );

  areas
    .command('get')
    .description('Show an area of interest')
    .argument('<areaId>', 'aoi_…')
    .action(
      define<[string]>(async (context, _options, areaId) => {
        const area = await context.client().areas.get({ projectId: context.projectId(), areaId });
        context.print(area, () =>
          details([
            ['ID', area.id],
            ['Name', area.name],
            ['Area', `${(area.areaSquareMeters / 1e6).toFixed(3)} km²`],
            [
              'Bounding box',
              `${String(area.bbox.west)}, ${String(area.bbox.south)}, ${String(area.bbox.east)}, ${String(area.bbox.north)}`,
            ],
            ['Created', area.createdAt],
          ]),
        );
      }),
    );

  idempotency(
    areas
      .command('create')
      .description('Create an area of interest from a GeoJSON file')
      .requiredOption('--name <name>', 'Area name')
      .requiredOption(
        '--geojson <path>',
        'Polygon or MultiPolygon (geometry, Feature or one-feature FeatureCollection)',
      )
      .option('--description <text>', 'Description'),
  ).action(
    define(async (context, options) => {
      const geometry = await readGeometry(required(options, 'geojson', '--geojson'));
      const description = optional(options, 'description');
      const area = await context.client().areas.create({
        projectId: context.projectId(),
        name: required(options, 'name', '--name'),
        geometry,
        ...(description === undefined ? {} : { description }),
        ...idempotencyKeyOf(options),
      });
      context.print(area, () =>
        details([
          ['Created area', area.id],
          ['Name', area.name],
          ['Area', `${(area.areaSquareMeters / 1e6).toFixed(3)} km²`],
        ]),
      );
    }),
  );

  const estimates = program
    .command('estimates')
    .description('Cost estimates (provider quotes, not bills)');

  withPaging(estimates.command('list').description('List cost estimates (newest first)')).action(
    define(async (context, options) => {
      const client = context.client();
      const projectId = context.projectId();
      const page = await readPage(
        options,
        (paging) => client.estimates.list({ projectId, ...paging }),
        (paging) => client.estimates.iterate({ projectId, ...paging }),
      );
      context.print(
        page,
        () =>
          table(
            page.data.map((estimate) => ({
              ...estimate,
              cost: money(estimate.amountMinor, estimate.currency),
            })),
            [
              ['ID', 'id'],
              ['Estimated cost', 'cost'],
              ['Provider', 'providerId'],
              ['Created', 'createdAt'],
            ],
            'No cost estimates.',
          ) + moreHint(page.nextCursor),
      );
    }),
  );

  estimates
    .command('get')
    .description('Show a cost estimate')
    .argument('<estimateId>', 'est_…')
    .action(
      define<[string]>(async (context, _options, estimateId) => {
        const estimate = await context
          .client()
          .estimates.get({ projectId: context.projectId(), estimateId });
        context.print(estimate, () => estimateDetails(estimate));
      }),
    );

  idempotency(
    estimates
      .command('create')
      .description('Ask a provider to price a validated version (optionally over an area)')
      .requiredOption('--model-version <versionId>', 'Model version (mdlver_…)')
      .requiredOption('--provider <providerId>', 'Provider (see `auvryn providers list`)')
      .option('--area <areaId>', 'Area of interest (aoi_…)'),
  ).action(
    define(async (context, options) => {
      const area = optional(options, 'area');
      const estimate = await context.client().estimates.create({
        projectId: context.projectId(),
        modelVersionId: required(options, 'modelVersion', '--model-version'),
        providerId: required(options, 'provider', '--provider'),
        ...(area === undefined ? {} : { areaOfInterestId: area }),
        ...idempotencyKeyOf(options),
      });
      context.print(
        estimate,
        () =>
          `${estimateDetails(estimate)}\n\nNext: auvryn executions run --estimate ${estimate.id}`,
      );
    }),
  );

  const executions = program.command('executions').description('Execution jobs');

  withPaging(
    executions
      .command('list')
      .description('List executions (newest first)')
      .option('--status <statuses>', 'Comma-separated statuses, e.g. scheduled,running')
      .option('--provider <providerId>', 'Only this provider')
      .option('--model-version <versionId>', 'Only this model version')
      .option('--created-after <iso>', 'Created at or after (ISO 8601)')
      .option('--created-before <iso>', 'Created before (ISO 8601)'),
  ).action(
    define(async (context, options) => {
      const client = context.client();
      const status = optional(options, 'status');
      const providerId = optional(options, 'provider');
      const modelVersionId = optional(options, 'modelVersion');
      const createdAfter = optional(options, 'createdAfter');
      const createdBefore = optional(options, 'createdBefore');
      const filters = {
        projectId: context.projectId(),
        ...(status === undefined
          ? {}
          : { status: status.split(',').map((s) => s.trim()) as ExecutionJobStatus[] }),
        ...(providerId === undefined ? {} : { providerId }),
        ...(modelVersionId === undefined ? {} : { modelVersionId }),
        ...(createdAfter === undefined ? {} : { createdAfter }),
        ...(createdBefore === undefined ? {} : { createdBefore }),
      };
      const page = await readPage(
        options,
        (paging) => client.executions.list({ ...filters, ...paging }),
        (paging) => client.executions.iterate({ ...filters, ...paging }),
      );
      context.print(
        page,
        () =>
          table(
            page.data,
            [
              ['ID', 'id'],
              ['Status', 'status'],
              ['Provider', 'providerId'],
              ['Created', 'createdAt'],
            ],
            'No executions.',
          ) + moreHint(page.nextCursor),
      );
    }),
  );

  executions
    .command('get')
    .description('Show an execution')
    .argument('<jobId>', 'job_…')
    .action(
      define<[string]>(async (context, _options, jobId) => {
        const job = await context
          .client()
          .executions.get({ projectId: context.projectId(), jobId });
        context.print(job, () => jobDetails(job));
      }),
    );

  idempotency(
    withWait(
      executions
        .command('run')
        .description(
          'Start an execution from a cost estimate (or directly); returns at once unless --wait',
        )
        .option('--estimate <estimateId>', 'Run what this estimate priced (est_…, preferred)')
        .option('--model-version <versionId>', 'Run this model version directly (with --provider)')
        .option('--provider <providerId>', 'Provider for a direct run')
        .option('--area <areaId>', 'Area of interest for a direct run'),
      EXECUTION_TIMEOUT,
    ),
  ).action(
    define(async (context, options) => {
      const estimate = optional(options, 'estimate');
      const version = optional(options, 'modelVersion');
      const provider = optional(options, 'provider');
      const area = optional(options, 'area');
      if ((estimate === undefined) === (version === undefined)) {
        throw new UsageError('Pass either --estimate, or --model-version with --provider.');
      }
      if (estimate !== undefined && (provider !== undefined || area !== undefined)) {
        throw new UsageError(
          '--provider and --area apply only to --model-version (the estimate already fixes them).',
        );
      }
      if (version !== undefined && provider === undefined) {
        throw new UsageError('--model-version needs --provider.');
      }
      if (options['wait'] === true) {
        timeoutOf(options, EXECUTION_TIMEOUT);
      }
      const projectId = context.projectId();
      const job = await context.client().executions.create({
        projectId,
        ...(estimate !== undefined
          ? { costEstimateId: estimate }
          : {
              modelVersionId: version ?? '',
              providerId: provider ?? '',
              ...(area === undefined ? {} : { areaOfInterestId: area }),
            }),
        ...idempotencyKeyOf(options),
      });
      if (options['wait'] !== true) {
        context.print(job, () => `${jobDetails(job)}\n\nNext: auvryn executions wait ${job.id}`);
        return;
      }
      await waitForJob(context, job.id, options);
    }),
  );

  idempotency(
    withWait(
      executions
        .command('sample')
        .description(
          "Run Auvryn's sample model on the Sample Environment (simulated); returns at once unless --wait",
        ),
      EXECUTION_TIMEOUT,
    ),
  ).action(
    define(async (context, options) => {
      if (options['wait'] === true) {
        timeoutOf(options, EXECUTION_TIMEOUT);
      }
      const job = await context.client().executions.createSample({
        projectId: context.projectId(),
        ...idempotencyKeyOf(options),
      });
      if (options['wait'] !== true) {
        context.print(
          job,
          () =>
            `${jobDetails(job)}\n\nSimulated: no model runs on real hardware.\nNext: auvryn executions wait ${job.id}`,
        );
        return;
      }
      await waitForJob(context, job.id, options);
    }),
  );

  executions
    .command('wait')
    .description(
      'Wait until an execution is completed, failed or cancelled (exit 3 unless completed)',
    )
    .argument('<jobId>', 'job_…')
    .option('--timeout <duration>', `Maximum wait (default ${EXECUTION_TIMEOUT})`)
    .action(
      define<[string]>(async (context, options, jobId) => {
        await waitForJob(context, jobId, options);
      }),
    );

  executions
    .command('cancel')
    .description('Request cancellation of an execution')
    .argument('<jobId>', 'job_…')
    .action(
      define<[string]>(async (context, _options, jobId) => {
        const job = await context
          .client()
          .executions.cancel({ projectId: context.projectId(), jobId });
        context.print(job, () => jobDetails(job));
      }),
    );
}
