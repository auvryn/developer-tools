import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResultArtifact, UsageEvent } from '@auvryn/sdk';
import type { Command } from 'commander';

import { UsageError } from '../context.js';
import { bytes, details, money, moreHint, table } from '../format.js';
import { type Define, optional } from '../program.js';
import { readPage, withPaging } from './shared.js';

/** A file name for an artifact: its own name, made safe, prefixed by its ID when names repeat. */
function fileNames(artifacts: readonly ResultArtifact[]): Map<string, string> {
  const safe = (name: string) =>
    name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'artifact';
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(safe(artifact.name), (counts.get(safe(artifact.name)) ?? 0) + 1);
  }
  return new Map(
    artifacts.map((artifact) => {
      const name = safe(artifact.name);
      return [artifact.id, (counts.get(name) ?? 0) > 1 ? `${artifact.id}-${name}` : name];
    }),
  );
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** `results …` and `usage …`. */
export function registerResultCommands(program: Command, define: Define): void {
  const results = program.command('results').description('Results of completed executions');

  results
    .command('get')
    .description('Show the result of an execution and its artifacts')
    .argument('<jobId>', 'job_…')
    .action(
      define<[string]>(async (context, _options, jobId) => {
        const result = await context
          .client()
          .results.get({ projectId: context.projectId(), jobId });
        context.print(result, () =>
          [
            details([
              ['Result', result.id],
              ['Execution', result.executionJobId],
              ['Provider', result.providerId],
              ['Artifacts', result.summary.artifactCount],
              ['Total size', bytes(result.summary.totalSizeBytes)],
            ]),
            '',
            table(
              result.artifacts.map((artifact) => ({
                ...artifact,
                size: bytes(artifact.sizeBytes),
              })),
              [
                ['ID', 'id'],
                ['Name', 'name'],
                ['Kind', 'kind'],
                ['Size', 'size'],
                ['SHA-256', 'sha256'],
              ],
              'No artifacts.',
            ),
          ].join('\n'),
        );
      }),
    );

  results
    .command('download')
    .description('Download result artifacts (streamed; SHA-256 verified)')
    .argument('<jobId>', 'job_…')
    .option('--artifact <artifactId>', 'Only this artifact (rart_…); default: all')
    .option('-o, --output <directory>', 'Directory to write to (default: current directory)')
    .option('--force', 'Overwrite existing files')
    .action(
      define<[string]>(async (context, options, jobId) => {
        const client = context.client();
        const projectId = context.projectId();
        const only = optional(options, 'artifact');
        const directory = optional(options, 'output') ?? '.';
        const result = await client.results.get({ projectId, jobId });
        const artifacts = result.artifacts.filter(
          (artifact) => only === undefined || artifact.id === only,
        );
        if (only !== undefined && artifacts.length === 0) {
          throw new UsageError(`The result has no artifact ${only}.`);
        }
        const names = fileNames(result.artifacts);
        await mkdir(directory, { recursive: true });
        const paths = artifacts.map((artifact) =>
          join(directory, names.get(artifact.id) ?? artifact.id),
        );
        if (options['force'] !== true) {
          for (const path of paths) {
            if (await exists(path)) {
              throw new UsageError(`${path} already exists (use --force to overwrite).`);
            }
          }
        }
        const files: { artifactId: string; path: string; sizeBytes: number; sha256: string }[] = [];
        for (const [index, artifact] of artifacts.entries()) {
          const path = paths[index] ?? '';
          context.note(`Downloading ${artifact.name} (${bytes(artifact.sizeBytes)})...`);
          const saved = await client.results.saveArtifact({
            projectId,
            jobId,
            artifactId: artifact.id,
            path,
          });
          files.push({
            artifactId: artifact.id,
            path: saved.path,
            sizeBytes: saved.sizeBytes,
            sha256: saved.sha256,
          });
        }
        context.note(`Downloaded ${String(files.length)} artifact(s); SHA-256 verified.`);
        context.print({ files }, () =>
          table(
            files,
            [
              ['Artifact', 'artifactId'],
              ['File', 'path'],
              ['SHA-256', 'sha256'],
            ],
            'No artifacts.',
          ),
        );
      }),
    );

  const usage = program
    .command('usage')
    .description('Usage and provider cost estimates (not billing)');

  withPaging(
    usage
      .command('list')
      .description('Usage events with totals per metric')
      .option('--job <jobId>', 'Only this execution')
      .option('--metric <metric>', 'Only this metric'),
  ).action(
    define(async (context, options) => {
      const client = context.client();
      const job = optional(options, 'job');
      const metric = optional(options, 'metric');
      const filters = {
        projectId: context.projectId(),
        ...(job === undefined ? {} : { executionJobId: job }),
        ...(metric === undefined ? {} : { metric: metric as UsageEvent['metric'] }),
      };
      const first = await client.usage.listEvents({ ...filters, limit: 1 });
      const page = await readPage(
        options,
        (paging) => client.usage.listEvents({ ...filters, ...paging }),
        (paging) => client.usage.iterateEvents({ ...filters, ...paging }),
      );
      const value = { ...page, totals: first.totals };
      context.print(value, () =>
        [
          table(
            first.totals,
            [
              ['Metric', 'metric'],
              ['Quantity', 'quantity'],
              ['Unit', 'unit'],
              ['Events', 'eventCount'],
            ],
            'No usage recorded.',
          ),
          '',
          table(
            page.data,
            [
              ['ID', 'id'],
              ['Execution', 'executionJobId'],
              ['Metric', 'metric'],
              ['Quantity', 'quantity'],
              ['Unit', 'unit'],
            ],
            'No usage events.',
          ) + moreHint(page.nextCursor),
        ].join('\n'),
      );
    }),
  );

  withPaging(
    usage
      .command('ledger')
      .description('Ledger entries (provider cost estimates) with totals per currency')
      .option('--job <jobId>', 'Only this execution'),
  ).action(
    define(async (context, options) => {
      const client = context.client();
      const job = optional(options, 'job');
      const filters = {
        projectId: context.projectId(),
        ...(job === undefined ? {} : { executionJobId: job }),
      };
      const first = await client.usage.listLedger({ ...filters, limit: 1 });
      const page = await readPage(
        options,
        (paging) => client.usage.listLedger({ ...filters, ...paging }),
        (paging) => client.usage.iterateLedger({ ...filters, ...paging }),
      );
      const value = { ...page, totals: first.totals };
      context.print(value, () =>
        [
          table(
            first.totals.map((total) => ({
              ...total,
              amount: money(total.amountMinor, total.currency),
            })),
            [
              ['Entry type', 'entryType'],
              ['Basis', 'costBasis'],
              ['Amount', 'amount'],
              ['Entries', 'entryCount'],
            ],
            'No ledger entries.',
          ),
          '',
          table(
            page.data.map((entry) => ({
              ...entry,
              amount: money(entry.amountMinor, entry.currency),
            })),
            [
              ['ID', 'id'],
              ['Execution', 'executionJobId'],
              ['Basis', 'costBasis'],
              ['Amount', 'amount'],
            ],
            'No ledger entries.',
          ) + moreHint(page.nextCursor),
        ].join('\n'),
      );
    }),
  );
}
