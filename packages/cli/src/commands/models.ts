import type { ModelValidation, ModelVersion, SandboxRun } from '@auvryn/sdk';
import type { Command } from 'commander';

import { type Context, UnsuccessfulOutcome } from '../context.js';
import { bytes, details, moreHint, table } from '../format.js';
import { type Define, optional, required } from '../program.js';
import {
  idempotency,
  idempotencyKeyOf,
  readPage,
  timeoutOf,
  withPaging,
  withWait,
} from './shared.js';

const VALIDATION_TIMEOUT = '5m';
const SANDBOX_TIMEOUT = '10m';

function versionDetails(version: ModelVersion): string {
  return details([
    ['ID', version.id],
    ['Version', version.version],
    ['Model', version.modelId],
    ['Format', version.format],
    ['Artifact', version.readiness.artifact],
    ['Validation', version.readiness.validation],
    ['Created', version.createdAt],
  ]);
}

function validationDetails(validation: ModelValidation): string {
  return details([
    ['Validation', validation.id],
    ['Status', validation.status],
    ['Validator', validation.validatorVersion],
    ['Error', validation.error ? `${validation.error.code}: ${validation.error.message}` : null],
  ]);
}

function sandboxDetails(run: SandboxRun): string {
  return details([
    ['Sandbox run', run.id],
    ['Status', run.status],
    ['Runtime', run.runtime ? `${run.runtime} ${run.runtimeVersion ?? ''}`.trim() : null],
    ['Error', run.error ? `${run.error.code}: ${run.error.message}` : null],
  ]);
}

/** Prints the outcome of a wait and signals an unsuccessful one (exit 3). */
function finish<T>(
  context: Context,
  value: T,
  human: (value: T) => string,
  succeeded: boolean,
): void {
  context.print(value, () => human(value));
  if (!succeeded) {
    throw new UnsuccessfulOutcome();
  }
}

/** `models …` and `sandbox …`. */
export function registerModelCommands(program: Command, define: Define): void {
  const models = program
    .command('models')
    .description('Models, versions, model files and validation');

  withPaging(models.command('list').description('List models (newest first)')).action(
    define(async (context, options) => {
      const client = context.client();
      const projectId = context.projectId();
      const page = await readPage(
        options,
        (paging) => client.models.list({ projectId, ...paging }),
        (paging) => client.models.iterate({ projectId, ...paging }),
      );
      context.print(
        page,
        () =>
          table(
            page.data,
            [
              ['ID', 'id'],
              ['Name', 'name'],
              ['Slug', 'slug'],
              ['Created', 'createdAt'],
            ],
            'No models.',
          ) + moreHint(page.nextCursor),
      );
    }),
  );

  models
    .command('get')
    .description('Show a model')
    .argument('<modelId>', 'mdl_…')
    .action(
      define<[string]>(async (context, _options, modelId) => {
        const model = await context
          .client()
          .models.get({ projectId: context.projectId(), modelId });
        context.print(model, () =>
          details([
            ['ID', model.id],
            ['Name', model.name],
            ['Slug', model.slug],
            ['Description', model.description],
            ['Created', model.createdAt],
          ]),
        );
      }),
    );

  idempotency(
    models
      .command('create')
      .description('Register a model')
      .requiredOption('--name <name>', 'Model name')
      .option('--slug <slug>', 'URL slug (derived from the name when omitted)')
      .option('--description <text>', 'Description'),
  ).action(
    define(async (context, options) => {
      const description = optional(options, 'description');
      const slug = optional(options, 'slug');
      const model = await context.client().models.create({
        projectId: context.projectId(),
        name: required(options, 'name', '--name'),
        ...(slug === undefined ? {} : { slug }),
        ...(description === undefined ? {} : { description }),
        ...idempotencyKeyOf(options),
      });
      context.print(model, () =>
        details([
          ['Created model', model.id],
          ['Name', model.name],
          ['Slug', model.slug],
        ]),
      );
    }),
  );

  models
    .command('versions')
    .description('List the versions of a model (highest first)')
    .argument('<modelId>', 'mdl_…')
    .action(
      define<[string]>(async (context, _options, modelId) => {
        const page = await context
          .client()
          .models.listVersions({ projectId: context.projectId(), modelId });
        context.print(page, () =>
          table(
            page.data.map((version) => ({
              ...version,
              artifact: version.readiness.artifact,
              validation: version.readiness.validation,
            })),
            [
              ['ID', 'id'],
              ['Version', 'version'],
              ['Format', 'format'],
              ['Artifact', 'artifact'],
              ['Validation', 'validation'],
            ],
            'No versions.',
          ),
        );
      }),
    );

  idempotency(
    models
      .command('upload')
      .description('Create a new version of a model and upload its ONNX file (does not validate)')
      .argument('<modelId>', 'mdl_…')
      .requiredOption('--file <path>', 'The .onnx file')
      .option('--framework <framework>', 'pytorch, tensorflow, scikit-learn, custom or unknown')
      .option('--description <text>', 'Version description'),
  ).action(
    define<[string]>(async (context, options, modelId) => {
      const client = context.client();
      const file = required(options, 'file', '--file');
      const framework = optional(options, 'framework');
      const description = optional(options, 'description');
      context.note(`Uploading ${file}...`);
      const { version, artifact } = await client.models.uploadVersion({
        projectId: context.projectId(),
        modelId,
        file,
        ...(framework === undefined ? {} : { framework: framework as ModelVersion['framework'] }),
        ...(description === undefined ? {} : { description }),
        ...idempotencyKeyOf(options),
      });
      context.note(`Uploaded (${bytes(artifact.sizeBytes)}, SHA-256 ${artifact.checksumSha256}).`);
      context.print(
        { version, artifact },
        () =>
          `${versionDetails(version)}\n\nNext: auvryn models validate ${modelId} ${version.id} --wait`,
      );
    }),
  );

  withWait(
    models
      .command('validate')
      .description('Validate the uploaded file of a version (asynchronous)')
      .argument('<modelId>', 'mdl_…')
      .argument('<versionId>', 'mdlver_…'),
    VALIDATION_TIMEOUT,
  ).action(
    define<[string, string]>(async (context, options, modelId, versionId) => {
      const client = context.client();
      const ref = { projectId: context.projectId(), modelId, versionId };
      const timeoutMs = options['wait'] === true ? timeoutOf(options, VALIDATION_TIMEOUT) : 0;
      let validation = await client.models.validate(ref);
      if (options['wait'] !== true) {
        context.print(validation, () => validationDetails(validation));
        return;
      }
      context.note(`Waiting for validation ${validation.id}...`);
      validation = await client.models.waitForValidation({ ...ref, timeoutMs });
      finish(context, validation, validationDetails, validation.status === 'valid');
    }),
  );

  models
    .command('validation')
    .description('Show the validation of a version')
    .argument('<modelId>', 'mdl_…')
    .argument('<versionId>', 'mdlver_…')
    .action(
      define<[string, string]>(async (context, _options, modelId, versionId) => {
        const validation = await context
          .client()
          .models.getValidation({ projectId: context.projectId(), modelId, versionId });
        context.print(validation, () => validationDetails(validation));
      }),
    );

  const sandbox = program.command('sandbox').description('Sandbox test runs of validated versions');

  idempotency(
    withWait(
      sandbox
        .command('run')
        .description('Run a validated version once in the sandbox (asynchronous)')
        .argument('<modelId>', 'mdl_…')
        .argument('<versionId>', 'mdlver_…'),
      SANDBOX_TIMEOUT,
    ),
  ).action(
    define<[string, string]>(async (context, options, modelId, versionId) => {
      const client = context.client();
      const ref = { projectId: context.projectId(), modelId, versionId };
      const timeoutMs = options['wait'] === true ? timeoutOf(options, SANDBOX_TIMEOUT) : 0;
      const run = await client.sandbox.run({ ...ref, ...idempotencyKeyOf(options) });
      if (options['wait'] !== true) {
        context.print(run, () => sandboxDetails(run));
        return;
      }
      context.note(`Waiting for sandbox run ${run.id}...`);
      const done = await client.sandbox.wait({ ...ref, sandboxRunId: run.id, timeoutMs });
      finish(context, done, sandboxDetails, done.status === 'completed');
    }),
  );

  sandbox
    .command('get')
    .description('Show a sandbox run')
    .argument('<modelId>', 'mdl_…')
    .argument('<versionId>', 'mdlver_…')
    .argument('<sandboxRunId>', 'sbox_…')
    .action(
      define<[string, string, string]>(
        async (context, _options, modelId, versionId, sandboxRunId) => {
          const run = await context
            .client()
            .sandbox.get({ projectId: context.projectId(), modelId, versionId, sandboxRunId });
          context.print(run, () => sandboxDetails(run));
        },
      ),
    );

  sandbox
    .command('wait')
    .description('Wait until a sandbox run finishes (exit 3 if it failed)')
    .argument('<modelId>', 'mdl_…')
    .argument('<versionId>', 'mdlver_…')
    .argument('<sandboxRunId>', 'sbox_…')
    .option('--timeout <duration>', `Maximum wait (default ${SANDBOX_TIMEOUT})`)
    .action(
      define<[string, string, string]>(
        async (context, options, modelId, versionId, sandboxRunId) => {
          const run = await context.client().sandbox.wait({
            projectId: context.projectId(),
            modelId,
            versionId,
            sandboxRunId,
            timeoutMs: timeoutOf(options, SANDBOX_TIMEOUT),
          });
          finish(context, run, sandboxDetails, run.status === 'completed');
        },
      ),
    );
}
