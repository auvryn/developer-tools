/**
 * Auvryn basic execution: the whole ExecutionJob lifecycle with @auvryn/sdk.
 *
 *   create → wait → result → provenance → telemetry
 *
 * It runs Auvryn's sample model on the Sample Environment, which every
 * workspace can use. That execution is SIMULATED: no model runs on real
 * hardware, and its provenance says `simulated: true`.
 *
 * Optionally, set AUVRYN_MODEL_PATH to one of your ONNX files: the example
 * then also uploads and validates it (validation checks the model; it does
 * not run it).
 *
 * Environment: AUVRYN_API_KEY (scopes executions:write, executions:read,
 * results:read; models:write and models:read for the optional upload) and
 * AUVRYN_PROJECT_ID.
 */
import { Auvryn, AuvrynError } from '@auvryn/sdk';

const projectId = process.env['AUVRYN_PROJECT_ID'];
if (!projectId) {
  console.error('Set AUVRYN_PROJECT_ID to a project of your API key’s workspace (prj_…).');
  process.exit(2);
}

// Reads AUVRYN_API_KEY; calls https://api.auvrynspace.com unless AUVRYN_API_URL says otherwise.
const auvryn = new Auvryn({ userAgent: 'auvryn-example-basic-execution/1.0' });

try {
  // 1. Create: 202, returns at once. The idempotency key makes a retry safe.
  const started = await auvryn.executions.createSample({
    projectId,
    idempotencyKey: Auvryn.idempotencyKey(),
  });
  console.log(`Started ${started.id} on ${started.providerId} (${started.status}).`);

  // 2. Wait until completed, failed or cancelled.
  const job = await auvryn.executions.wait({ projectId, jobId: started.id });
  console.log(`Finished: ${job.status}.`);
  if (job.status !== 'completed') {
    console.error(job.failure ?? 'The execution did not complete.');
    process.exit(3);
  }

  // 3. The result: artifacts stored by Auvryn, each with its size and SHA-256.
  const result = await auvryn.results.get({ projectId, jobId: job.id });
  for (const artifact of result.artifacts) {
    console.log(
      `Artifact ${artifact.name}: ${artifact.sizeBytes} bytes, sha256 ${artifact.sha256}`,
    );
  }

  // 4. Provenance: where and on what it ran, as far as it is known.
  const provenance = job.telemetry?.provenance;
  console.log('Provenance:', {
    provider: provenance?.provider.id,
    executionEnvironment: provenance?.executionEnvironment,
    simulated: provenance?.simulated,
  });

  // 5. Telemetry: every figure keeps its source (reported, measured or derived).
  for (const metric of job.telemetry?.metrics ?? []) {
    const name = metric.label === null ? metric.metric : `${metric.metric}/${metric.label}`;
    console.log(`  ${name} = ${metric.value} ${metric.unit} (${metric.source})`);
  }

  // Optional: your own ONNX model, uploaded and validated.
  const modelPath = process.env['AUVRYN_MODEL_PATH'];
  if (modelPath) {
    const model = await auvryn.models.create({
      projectId,
      name: `Example model ${new Date().toISOString()}`,
      idempotencyKey: Auvryn.idempotencyKey(),
    });
    const { version } = await auvryn.models.uploadVersion({
      projectId,
      modelId: model.id,
      file: modelPath,
      idempotencyKey: Auvryn.idempotencyKey(),
    });
    await auvryn.models.validate({ projectId, modelId: model.id, versionId: version.id });
    const validation = await auvryn.models.waitForValidation({
      projectId,
      modelId: model.id,
      versionId: version.id,
    });
    console.log(`Your model ${model.id} version ${version.id}: ${validation.status}.`);
  }
} catch (error) {
  if (error instanceof AuvrynError) {
    console.error(
      `${error.code}: ${error.message}`,
      error.requestId ? `(request ${error.requestId})` : '',
    );
    process.exit(1);
  }
  throw error;
}
