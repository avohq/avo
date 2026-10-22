#!/usr/bin/env node
// Large-repo check for `avo status` (AVO-4176, avohq/avo#610).
//
// Generates a repo shaped like a big React Native app, then runs `avo status`
// on a 2 GB heap with the patched build and with the current release. The
// patched build must exit 0, find every event and print the oversized-file
// warning; the release must run out of memory, or the check proves nothing.
// Wall time and peak RSS are recorded, not gated.
//
// Not shipped (it is outside package.json `files`). Run it by hand before a
// release, on macOS under Node 14.x and Node 24.x, and paste the table it
// prints into the release PR:
//
//   yarn build && node scripts/large-repo-check.mjs [--release 3.7.0]
//
// It needs about 3.5 GB of free disk under os.tmpdir(), and deletes the repo
// when it finishes, even after an out-of-memory run.
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';

const HEAP_MB = 2048;
const MiB = 1024 * 1024;

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const releaseVersion = option('release', '3.7.0');
const patchedCli = path.resolve(
  option('patched', path.join(scriptDir, '..', 'cli.js')),
);

const EVENTS = Array.from({ length: 20 }, (_, index) => `event${index}`);

// Ignored files in the reporter's proportions, about 16 KiB each (about 3 GB)
const IGNORED = [
  ['node_modules', 114000],
  ['ios/Pods', 31000],
  ['ios/build', 32000],
  ['android/app/.cxx', 6000],
  ['android/.gradle', 6000],
];
const IGNORED_FILE_BYTES = 16 * 1024;
const UNTRACKED_TEST_FILES = 12000;
// Fills the memory budget: READ_CONCURRENCY (16) reads of files just under
// the size cap, twice over
const NEAR_CAP_FILES = 32;
const NEAR_CAP_BYTES = Math.round(9.9 * MiB);
const OVERSIZED_FILES = 3;
const OVERSIZED_BYTES = Math.round(10.5 * MiB);

// Deterministic JS-ish text of exactly `bytes` bytes
function filler(bytes, seed) {
  const line = `export const value${seed} = 'lorem ipsum dolor sit amet';\n`;
  return Buffer.from(line.repeat(Math.ceil(bytes / line.length))).subarray(
    0,
    bytes,
  );
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function generateRepo(root) {
  const app = path.join(root, 'app');
  writeFile(
    path.join(root, '.gitignore'),
    ['node_modules/', 'build/', '.cxx/', '.gradle/', 'Pods/', ''].join('\n'),
  );
  writeFile(
    path.join(app, 'avo.json'),
    JSON.stringify(
      {
        avo: { version: 3 },
        schema: { id: 'large-repo-check', name: 'Large repo check' },
        branch: { id: 'master', name: 'main' },
        sources: [{ id: 'app', name: 'App', path: 'src/Avo.ts' }],
      },
      null,
      2,
    ),
  );
  writeFile(
    path.join(app, 'src/Avo.ts'),
    `// AVOEVENTMAP: ${JSON.stringify(EVENTS)}\n`,
  );
  writeFile(
    path.join(app, 'src/events.ts'),
    EVENTS.map((event) => `Avo.${event}();\n`).join(''),
  );
  for (let index = 0; index < NEAR_CAP_FILES; index += 1) {
    writeFile(
      path.join(app, `src/large/large${index}.ts`),
      filler(NEAR_CAP_BYTES, index),
    );
  }
  // None of them holds an event's only usage
  for (let index = 0; index < OVERSIZED_FILES; index += 1) {
    writeFile(
      path.join(app, `src/oversized/bundle${index}.min.js`),
      Buffer.concat([
        Buffer.from(`Avo.${EVENTS[index]}();\n`),
        filler(OVERSIZED_BYTES, index),
      ]),
    );
  }

  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=Avo',
    '-c',
    'user.email=check@avo.app',
    'commit',
    '-q',
    '-m',
    'Large repo check',
  );

  for (let index = 0; index < UNTRACKED_TEST_FILES; index += 1) {
    writeFile(
      path.join(app, `tests/e2e-tests/suite${index % 100}/test${index}.ts`),
      `it('works ${index}', () => {});\n`,
    );
  }

  IGNORED.forEach(([folder, count]) => {
    const content = filler(IGNORED_FILE_BYTES, folder.length);
    for (let index = 0; index < count; index += 1) {
      // 100 files per folder, like a package tree
      writeFile(
        path.join(app, folder, `pkg${Math.floor(index / 100)}/file${index}.js`),
        content,
      );
    }
  });

  return app;
}

function installRelease(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      dir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `avo@${releaseVersion}`,
    ],
    { stdio: 'inherit' },
  );
  return path.join(dir, 'node_modules', 'avo', 'cli.js');
}

// Runs `avo status` and records exit, output, wall time and peak RSS. RSS
// comes from a preload that writes it on exit, so a run that runs out of
// memory records none.
function runStatus(cli, cwd, rssFile) {
  const preload = path.join(path.dirname(rssFile), 'record-rss.cjs');
  fs.writeFileSync(
    preload,
    `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(
      rssFile,
    )}, String(process.resourceUsage().maxRSS)));\n`,
  );
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${HEAP_MB}`, '--require', preload, cli, 'status'],
      { cwd, env: { ...process.env, CI: 'true' } },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code, signal) => {
      const rssKiB = fs.existsSync(rssFile)
        ? Number(fs.readFileSync(rssFile, 'utf8'))
        : null;
      resolve({
        code,
        signal,
        output,
        seconds: (Date.now() - started) / 1000,
        // maxRSS is in KiB
        peakRssMiB: rssKiB === null ? null : Math.round(rssKiB / 1024),
        outOfMemory: /heap out of memory|Allocation failed/i.test(output),
      });
    });
  });
}

function describeRun(run) {
  if (run.outOfMemory) {
    return 'out of memory';
  }
  return run.signal ? `killed by ${run.signal}` : `exit ${run.code}`;
}

async function main() {
  if (!fs.existsSync(patchedCli)) {
    throw new Error(`No patched build at ${patchedCli}; run yarn build first`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-large-repo-'));
  let failed = false;
  try {
    console.log(`Generating the repo in ${root} ...`);
    const app = generateRepo(path.join(root, 'repo'));
    const releaseCli = installRelease(path.join(root, 'release'));

    console.log('Running the patched build ...');
    const patched = await runStatus(
      patchedCli,
      app,
      path.join(root, 'patched-rss'),
    );
    console.log(`Running avo@${releaseVersion} ...`);
    const release = await runStatus(
      releaseCli,
      app,
      path.join(root, 'release-rss'),
    );

    const gates = [
      ['patched build exits 0', patched.code === 0],
      [
        'patched build finds every event',
        patched.output.includes(`${EVENTS.length} events seen in code`),
      ],
      [
        'patched build warns about the oversized files',
        patched.output.includes(
          `Skipped ${OVERSIZED_FILES} files over the 10 MiB size cap`,
        ),
      ],
      [`avo@${releaseVersion} runs out of memory`, release.outOfMemory],
    ];
    failed = gates.some(([, passed]) => !passed);

    const rss = (run) =>
      run.peakRssMiB === null ? 'n/a' : `${run.peakRssMiB} MiB`;
    console.log(
      [
        '',
        `Large-repo check: Node ${process.version}, ${os.platform()} ${os.arch()}, --max-old-space-size=${HEAP_MB}`,
        '',
        '| Build | Result | Wall time | Peak RSS |',
        '| --- | --- | --- | --- |',
        `| patched | ${describeRun(patched)} | ${patched.seconds.toFixed(1)} s | ${rss(patched)} |`,
        `| avo@${releaseVersion} | ${describeRun(release)} | ${release.seconds.toFixed(1)} s | ${rss(release)} |`,
        '',
        ...gates.map(([name, passed]) => `- [${passed ? 'x' : ' '}] ${name}`),
        '',
      ].join('\n'),
    );
    if (failed) {
      console.log(`Patched build output:\n${patched.output.slice(-4000)}`);
      console.log(
        `avo@${releaseVersion} output:\n${release.output.slice(-4000)}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
