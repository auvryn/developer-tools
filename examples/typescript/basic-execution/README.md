# Basic execution (TypeScript)

The whole Auvryn ExecutionJob lifecycle with [`@auvryn/sdk`](https://www.npmjs.com/package/@auvryn/sdk):
create → wait → result → provenance → telemetry.

It runs Auvryn's sample model on the **Sample Environment**, which every workspace can use. That
execution is **simulated**: no model runs on real hardware, and its provenance says
`simulated: true`. With `AUVRYN_MODEL_PATH` set, it also uploads and validates one of your ONNX
models (validation checks the model; it does not run it).

## Run

Requires Node.js 24 or later.

```bash
npm install
export AUVRYN_API_KEY="auv_…"      # scopes: executions:write, executions:read, results:read
export AUVRYN_PROJECT_ID="prj_…"
npm start
```

Optional: `export AUVRYN_MODEL_PATH=./model.onnx` (adds `models:write` and `models:read` to the
key's scopes).

Each run uses one of the workspace's daily sample runs (5 per UTC day).

Exit codes: `0` completed, `1` API error (code and request ID printed), `2` configuration missing,
`3` the execution did not complete.
