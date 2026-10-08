#!/usr/bin/env node
// Release guard for @auvryn/sdk, @auvryn/cli and @auvryn/mcp. It checks what would be published
// (the packed tarballs) and what this repository contains:
//
//   node scripts/verify-packages.mjs                 pack every package, check tarballs + repository
//   node scripts/verify-packages.mjs --tarball <tgz> check one tarball (the release workflow)
//
// Tarballs: only package.json, README.md, LICENSE and compiled dist files; a public manifest
// (Apache-2.0, this repository, provenance, Node 24+, no install scripts, no local or workspace
// dependency); the SDK's default API URL is production. Everything: no secrets, no local paths,
// no links into private sources and none of a list of non-public names (compared by hash, so the
// list itself discloses nothing). Exits 1 on any problem.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const REPOSITORY = 'git+https://github.com/auvryn/developer-tools.git';
const PRODUCTION_API = 'https://api.auvrynspace.com';
const PACKAGES = {
  '@auvryn/sdk': { bin: undefined },
  '@auvryn/cli': { bin: 'auvryn' },
  '@auvryn/mcp': { bin: 'auvryn-mcp' },
};

const SECRETS = [
  ['an API key', /auv_[0-9a-z]{26}_[A-Za-z0-9]{40,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['a live API key', /\b(sk|pk)_live_[A-Za-z0-9]{10,}/],
  ['a webhook secret', /\bwhsec_[A-Za-z0-9]{16,}/],
  ['a credentialed database URL', /postgres(ql)?:\/\/[^\s:@/]+:[^\s@/]+@/],
  ['a local path', /[A-Za-z]:\\Users\\|\/Users\/[a-z]|\/home\/[a-z]/],
  ['a link into private sources', /\]\(\.\.\/\.\.\/(docs|apps|infra)\//],
];

/** SHA-256 prefixes of words and word pairs that must not appear (not public yet). */
const HIDDEN_WORDS = new Set([
  'f31639a23c744015',
  '3594ced783cbd696',
  'd7499bbe2ccfee41',
  '14ff0901aca668b6',
  'acd5f46ccf3f582a',
  'bcc373bba5c2d2eb',
  'f3eff70a6d0f31dd',
  'f6b44fc0db47e938',
  'be0b5f2b18fc9fe5',
  '294aa8d75483b833',
]);
const HIDDEN_PAIRS = new Set([
  'c1e9075ec2f63136',
  '5facdc352274746c',
  '400b19db67affd59',
  'f0ab1fcab73ac880',
]);

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** How many non-public names a text contains. */
export function hiddenNames(text) {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
  const hits = new Set();
  for (let index = 0; index < words.length; index += 1) {
    if (HIDDEN_WORDS.has(hash(words[index]))) hits.add(index);
    if (index + 1 < words.length && HIDDEN_PAIRS.has(hash(`${words[index]} ${words[index + 1]}`))) {
      hits.add(index);
    }
  }
  return hits.size;
}

function scanText(label, text, problems) {
  for (const [what, pattern] of SECRETS) {
    if (pattern.test(text)) problems.push(`${label}: contains ${what}`);
  }
  const hidden = hiddenNames(text);
  if (hidden > 0) problems.push(`${label}: contains ${hidden} non-public name(s)`);
}

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function checkTarball(tarball, problems) {
  const work = mkdtempSync(join(tmpdir(), 'auvryn-verify-'));
  try {
    execFileSync(
      'tar',
      [...(process.platform === 'win32' ? ['--force-local'] : []), '-xzf', tarball],
      {
        cwd: work,
        stdio: 'pipe',
      },
    );
    const base = join(work, 'package');
    const files = walk(base).map((path) => relative(base, path).replaceAll('\\', '/'));
    const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    const label = `${manifest.name}@${manifest.version}`;
    const expected = PACKAGES[manifest.name];
    if (!expected) {
      problems.push(`${tarball}: unexpected package ${manifest.name}`);
      return;
    }
    for (const file of files) {
      if (!/^(package\.json|README\.md|LICENSE|dist\/[\w./-]+\.(js|d\.ts))$/.test(file)) {
        problems.push(`${label}: unexpected file ${file}`);
      }
      scanText(`${label} ${file}`, readFileSync(join(base, file), 'utf8'), problems);
    }
    for (const required of ['README.md', 'LICENSE', 'package.json']) {
      if (!files.includes(required)) problems.push(`${label}: no ${required}`);
    }
    if (manifest.private) problems.push(`${label}: private`);
    if (manifest.license !== 'Apache-2.0') problems.push(`${label}: license is not Apache-2.0`);
    if (manifest.repository?.url !== REPOSITORY)
      problems.push(`${label}: repository is not ${REPOSITORY}`);
    if (
      manifest.publishConfig?.access !== 'public' ||
      manifest.publishConfig?.provenance !== true
    ) {
      problems.push(`${label}: publishConfig must be public with provenance`);
    }
    if (manifest.engines?.node !== '>=24') problems.push(`${label}: engines.node must be >=24`);
    for (const script of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
      if (manifest.scripts?.[script]) problems.push(`${label}: has a ${script} script`);
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (/^(workspace|catalog|file|link|git|https?):/.test(range)) {
        problems.push(`${label}: dependency ${name}@${range} is not a registry range`);
      }
    }
    if (expected.bin) {
      const target = manifest.bin?.[expected.bin];
      if (!target || !files.includes(target.replace(/^\.\//, ''))) {
        problems.push(`${label}: bin ${expected.bin} is missing`);
      } else if (!readFileSync(join(base, target), 'utf8').startsWith('#!/usr/bin/env node')) {
        problems.push(`${label}: bin ${expected.bin} has no node shebang`);
      }
    }
    const code = files
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(base, file), 'utf8'))
      .join('\n');
    if (/localhost|127\.0\.0\.1/.test(code))
      problems.push(`${label}: compiled code mentions a local address`);
    if (manifest.name === '@auvryn/sdk' && !code.includes(`'${PRODUCTION_API}'`)) {
      problems.push(`${label}: the default API URL is not ${PRODUCTION_API}`);
    }
    process.stdout.write(`  ${label}: ${files.length} files\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function checkRepository(problems) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT })
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  for (const path of tracked) {
    if (path === SELF || path === 'pnpm-lock.yaml') continue;
    const text = readFileSync(join(ROOT, path), 'utf8');
    scanText(path, text, problems);
    if (path.endsWith('.md')) {
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue;
        if (!existsSync(join(ROOT, dirname(path), target)))
          problems.push(`${path}: broken link ${target}`);
      }
    }
  }
  process.stdout.write(`  repository: ${tracked.length} tracked files\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const problems = [];
  if (argv[0] === '--tarball') {
    checkTarball(resolve(argv[1]), problems);
  } else {
    const out = mkdtempSync(join(tmpdir(), 'auvryn-pack-'));
    try {
      execFileSync('pnpm', ['-r', 'pack', '--pack-destination', out], {
        cwd: ROOT,
        stdio: 'pipe',
        shell: process.platform === 'win32',
      });
      const tarballs = readdirSync(out).filter((name) => name.endsWith('.tgz'));
      if (tarballs.length !== Object.keys(PACKAGES).length)
        problems.push(`expected 3 tarballs, got ${tarballs.length}`);
      for (const name of tarballs) checkTarball(join(out, name), problems);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    checkRepository(problems);
  }
  if (problems.length > 0) {
    process.stderr.write(
      `Release guard failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('Release guard passed.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
