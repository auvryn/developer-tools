#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { runCli } from './program.js';

/*
 * The `auvryn` command. No telemetry, no config files, no stored secrets: the
 * API key comes from AUVRYN_API_KEY only, and every API call goes through
 * @auvryn/sdk.
 */
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  version,
});
