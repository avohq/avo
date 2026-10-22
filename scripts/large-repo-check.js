// Large-repo check for `avo status` (AVO-4176, avohq/avo#610). Run by hand
// before a release; the results table goes in the release PR. Not shipped:
// it stays outside package.json `files`.
//
// It generates a repo shaped like the one in #610 (about 189k ignored files,
// about 3 GB) in a new folder under os.tmpdir(), runs `avo status` there with
// each build on each Node binary, prints a markdown table, and deletes the
// repo in `finally`, also after a run that ran out of memory. It needs macOS
// (for `/usr/bin/time -l`), git, and about 3.5 GB of free disk, which it checks
// before it starts only when run on Node 18.15 or later (fs.statfsSync).
//
//   yarn build
//   node scripts/large-repo-check.js \
//     --node "$(nvm which 14)" \
//     --node "$(nvm which 24)" \
//     --candidate ./cli.js \
//     --baseline "$(npm root -g)/avo/cli.js" \
//     --out large-repo-results.md
//
// The release PR expects both --node values: a Node 14.x and a Node 24.x
// binary.
//
// Options:
//   --shape gated|reporter  gated (default) is the release gate. reporter is
//                           informational: shaped like the #610 reporter's repo.
//   --node <path>           a Node binary to run status with (repeatable;
//                           default: the Node running this script)
//   --candidate <cli.js>    the build under test (default: this checkout's cli.js)
//   --baseline <cli.js>     the current release, e.g. a global `avo@3.7.0`
//   --heap <MB>             --max-old-space-size for every run (default 2048);
//                           any other heap fails the gate
//   --timeout <minutes>     kill a run after this long (default 30)
//   --scale <n>             divide every file count by n, to try the script out;
//                           any scale but 1 (the default) fails the gate
//   --out <file>            also write the markdown to this file
//
// The gate (gated shape only, at the default --heap and --scale; exit 1 if it
// fails): every candidate run exits 0, finds all 20 of the repo's events and
// prints the oversized-file warning, and every baseline run runs out of
// memory. Wall time and peak RSS are recorded, not gated.
//
// Each run is `/usr/bin/time -l <node> --max-old-space-size=<heap> <cli.js>
// status` (macOS: time reports peak RSS in bytes), with FORCE_COLOR=0,
// NO_UPDATE_NOTIFIER=1, and AVO_API_ORIGIN pointed at a closed local port, so
// the CLI's own analytics destination sends nothing. Each run still sends its
// cliInvoked event's schema (no property values, in prod) to Avo Inspector:
// the Inspector client always posts to api.avo.app, and the CLI has no setting
// that stops it.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const MIB = 1024 * 1024;

// The same 10 MiB cap as `avo status`.
const SIZE_CAP_BYTES = 10 * MIB;

// The spec's heap for every gated run: what an 8 GB machine gets by default.
const GATE_HEAP_MB = 2048;

const EVENT_COUNT = 20;

// Folders git ignores, in the proportions of the repo in avohq/avo#610: about
// 189k files, about 3 GB. Paths are relative to the project folder.
const IGNORED_FOLDERS = [
  { folder: 'node_modules', files: 114000, group: 'pkg', ext: 'js' },
  { folder: 'ios/Pods', files: 31000, group: 'Pod', ext: 'm' },
  { folder: 'ios/build', files: 32000, group: 'Intermediates', ext: 'json' },
  { folder: 'android/app/.cxx', files: 6000, group: 'cmake', ext: 'txt' },
  { folder: 'android/.gradle', files: 6000, group: 'caches', ext: 'bin' },
];

// Cycled through, for an average of 16.5 KiB per ignored file.
const IGNORED_FILE_SIZES = [4096, 8192, 16384, 38912];

const FILES_PER_FOLDER = 100;

const E2E_TEST_COUNT = 12000;
const E2E_TEST_SIZE = 1024;

// Sizes around the cap are percentages of it: 9.9 MiB for the near-cap files,
// and 10.5, 12 and 14.2 MiB for the oversized ones, at the 10 MiB cap.
const ofCap = (sizeCap, percent) => Math.floor((sizeCap * percent) / 100);

// Enough files just under the cap to keep every concurrent read near the cap.
const NEAR_CAP_FILE_COUNT = 32;
const NEAR_CAP_PERCENT = 99;

// Opens each near-cap file. `…` is outside Latin-1, so V8 holds the file read
// as a two-byte string, the worst case the memory budget allows for; ASCII
// filler alone would fill only half of it.
const NEAR_CAP_HEAD = '// Generated catalog…\n';

// Over the cap. Each calls an event that is also called from a file under the
// cap, so no event's only usage is in an oversized file.
const OVERSIZED_PERCENTS = [105, 120, 142];

// The stock React Native .gitignore lines for the folders above.
const STOCK_REACT_NATIVE_GITIGNORE = [
  '# React Native',
  'node_modules/',
  'build/',
  '.cxx/',
  '.gradle/',
  'Pods/',
  '',
].join('\n');

const FILLER_LINE =
  "export const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit';\n";

// Same contents on every run: a repo built twice is byte-identical.
const fillerOf = (size) => {
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += FILLER_LINE.length) {
    buffer.write(FILLER_LINE, offset, 'latin1');
  }
  return buffer;
};

const pad = (n, width) => String(n).padStart(width, '0');

const eventNames = () =>
  Array.from(
    { length: EVENT_COUNT },
    (_, index) => `largeRepoEvent${pad(index + 1, 2)}`,
  );

// Scales a count down for trying the script out (and for its tests), keeping
// at least one of everything.
const scaled = (count, scale) => Math.max(1, Math.round(count / scale));

// Writes `head` and then filler, so the file is exactly `size` bytes.
const writeSized = (filePath, head, size, filler) => {
  const headBytes = Buffer.from(head, 'utf8');
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, headBytes);
    let remaining = size - headBytes.length;
    while (remaining > 0) {
      const chunk = Math.min(remaining, filler.length);
      fs.writeSync(fd, filler, 0, chunk);
      remaining -= chunk;
    }
  } finally {
    fs.closeSync(fd);
  }
};

const writeText = (filePath, contents) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
};

// Writes `count` files below `dir`, FILES_PER_FOLDER per subfolder, and
// returns how many bytes it wrote.
const writeFolderOfFiles = (dir, { count, group, ext, sizeOf, filler }) => {
  let bytes = 0;
  for (let index = 0; index < count; index += 1) {
    const subfolder = path.join(
      dir,
      `${group}-${pad(Math.floor(index / FILES_PER_FOLDER), 4)}`,
    );
    if (index % FILES_PER_FOLDER === 0) {
      fs.mkdirSync(subfolder, { recursive: true });
    }
    const name = `file-${pad(index % FILES_PER_FOLDER, 3)}.${ext}`;
    writeSized(
      path.join(subfolder, name),
      `// ${group} ${index}\n`,
      sizeOf(index),
      filler,
    );
    bytes += sizeOf(index);
  }
  return bytes;
};

const gitIn = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    // Passed explicitly so jest's copy of process.env reaches git.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Avo large-repo check',
      GIT_AUTHOR_EMAIL: 'large-repo-check@avo.app',
      GIT_COMMITTER_NAME: 'Avo large-repo check',
      GIT_COMMITTER_EMAIL: 'large-repo-check@avo.app',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
    stdio: 'pipe',
  });

const avoJson = () =>
  `${JSON.stringify(
    {
      avo: { version: 3 },
      schema: { id: 'large-repo-check', name: 'Large repo check' },
      branch: { id: 'main', name: 'main' },
      sources: [{ id: 'large-repo-check', name: 'App', path: 'Avo.ts' }],
    },
    null,
    2,
  )}\n`;

const avoTs = (events) =>
  [
    '// Stands in for a generated Avo file: status reads the two maps below.',
    '// AVOMODULEMAP:"Avo"',
    `// AVOEVENTMAP:${JSON.stringify(events)}`,
    'export default {};',
    '',
  ].join('\n');

// Below the top level, in the reporter shape only: git ignores them, and the
// walker in 3.7.0 doesn't.
const NESTED_NODE_MODULES = [
  { folder: 'tests/e2e-tests/node_modules', files: 6000 },
  { folder: 'packages/core/node_modules', files: 2000 },
  { folder: 'packages/ui/node_modules', files: 2000 },
  { folder: 'packages/utils/node_modules', files: 2000 },
].map((nested) => ({ ...nested, group: 'pkg', ext: 'js' }));

const SHAPES = {
  // The gate: a repo root with a stock React Native .gitignore, and the
  // project folder `app/` below it, holding the ignored folders.
  gated: {
    projectFolder: 'app',
    gitignore: () => STOCK_REACT_NATIVE_GITIGNORE,
    ignoredFolders: IGNORED_FOLDERS,
  },
  // Informational: shaped like the #610 reporter's repo, whose project folder
  // is the repo root, with a stand-in for their .gitignore and a few nested
  // node_modules folders.
  reporter: {
    projectFolder: '',
    gitignore: () =>
      fs.readFileSync(
        new URL('reporter-610.gitignore', import.meta.url),
        'utf8',
      ),
    ignoredFolders: [...IGNORED_FOLDERS, ...NESTED_NODE_MODULES],
  },
};

export const SHAPE_NAMES = Object.keys(SHAPES);

// Generates a repo at `repoRoot` (which must not exist yet), deterministically,
// and returns where its project folder is and what it holds. `scale` divides
// every file count, for trying the script out; only scale 1 is the real check.
// `sizeCap` sizes the files around the cap; only status's own cap (the
// default) is the real check, and a small one keeps the script's tests cheap.
export function generateRepo(
  repoRoot,
  { shape = 'gated', scale = 1, sizeCap = SIZE_CAP_BYTES } = {},
) {
  const definition = SHAPES[shape];
  if (definition === undefined) {
    throw new Error(`Unknown shape '${shape}'`);
  }
  const projectFolder = path.join(repoRoot, definition.projectFolder);
  const events = eventNames();
  fs.mkdirSync(projectFolder, { recursive: true });

  writeText(path.join(repoRoot, '.gitignore'), definition.gitignore());
  writeText(path.join(projectFolder, 'avo.json'), avoJson());
  writeText(path.join(projectFolder, 'Avo.ts'), avoTs(events));

  // The committed source: every event called once from its own small file.
  events.forEach((event) => {
    writeText(
      path.join(projectFolder, 'src', 'events', `${event}.ts`),
      `import Avo from '../../Avo';\n\nAvo.${event}({});\n`,
    );
  });

  const nearCapFiller = fillerOf(MIB);
  const nearCapCount = scaled(NEAR_CAP_FILE_COUNT, scale);
  fs.mkdirSync(path.join(projectFolder, 'src', 'generated'), {
    recursive: true,
  });
  for (let index = 0; index < nearCapCount; index += 1) {
    writeSized(
      path.join(
        projectFolder,
        'src',
        'generated',
        `catalog-${pad(index, 2)}.ts`,
      ),
      `${NEAR_CAP_HEAD}import Avo from '../../Avo';\n\nAvo.${
        events[index % events.length]
      }({});\n`,
      ofCap(sizeCap, NEAR_CAP_PERCENT),
      nearCapFiller,
    );
  }

  fs.mkdirSync(path.join(projectFolder, 'src', 'vendor'), { recursive: true });
  OVERSIZED_PERCENTS.forEach((percent, index) => {
    writeSized(
      path.join(projectFolder, 'src', 'vendor', `bundle-${index + 1}.min.js`),
      `Avo.${events[index]}({});\n`,
      ofCap(sizeCap, percent),
      nearCapFiller,
    );
  });

  gitIn(repoRoot, '-c', 'init.defaultBranch=main', 'init', '-q');
  gitIn(repoRoot, '-c', 'core.looseCompression=1', 'add', '--', '.');
  gitIn(
    repoRoot,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    'Generated by the large-repo check',
  );

  // Untracked: written after the commit.
  const e2eTests = scaled(E2E_TEST_COUNT, scale);
  writeFolderOfFiles(path.join(projectFolder, 'tests', 'e2e-tests', 'specs'), {
    count: e2eTests,
    group: 'suite',
    ext: 'ts',
    sizeOf: () => E2E_TEST_SIZE,
    filler: fillerOf(E2E_TEST_SIZE),
  });

  const ignoredFiller = fillerOf(Math.max(...IGNORED_FILE_SIZES));
  const ignored = {};
  let ignoredBytes = 0;
  definition.ignoredFolders.forEach(({ folder, files, group, ext }) => {
    const count = scaled(files, scale);
    ignoredBytes += writeFolderOfFiles(path.join(projectFolder, folder), {
      count,
      group,
      ext,
      sizeOf: (index) => IGNORED_FILE_SIZES[index % IGNORED_FILE_SIZES.length],
      filler: ignoredFiller,
    });
    ignored[folder] = count;
  });

  return {
    shape,
    repoRoot,
    projectFolder,
    events,
    counts: {
      ignored,
      ignoredBytes,
      e2eTests,
      nearCap: nearCapCount,
      oversized: OVERSIZED_PERCENTS.length,
    },
  };
}

// Reads one `/usr/bin/time -l node … cli.js status` run, run with
// FORCE_COLOR=0: `stdout` is status's own output, and `stderr` is Node's
// followed by time's report.
export function summariseRun({ exitCode, stdout, stderr }) {
  const someSeen = /^info (\d+) of (\d+) events seen in code$/m.exec(stdout);
  const allSeen = /^info (\d+) events seen in code$/m.exec(stdout);
  let eventsSeen = null;
  let eventsTotal = null;
  if (someSeen !== null) {
    eventsSeen = Number(someSeen[1]);
    eventsTotal = Number(someSeen[2]);
  } else if (allSeen !== null) {
    eventsSeen = Number(allSeen[1]);
    eventsTotal = eventsSeen;
  }
  const wall = /^\s*([\d.]+) real\b/m.exec(stderr);
  const rss = /^\s*(\d+)\s+maximum resident set size$/m.exec(stderr);
  return {
    exitCode,
    outOfMemory: /JavaScript heap out of memory/.test(stderr),
    eventsSeen,
    eventsTotal,
    warnings: stdout
      .split('\n')
      .filter((line) => line.startsWith('warn '))
      .map((line) => line.slice('warn '.length)),
    wallSeconds: wall === null ? null : Number(wall[1]),
    peakRssBytes: rss === null ? null : Number(rss[1]),
  };
}

// The gate, from the spec: on the full-size gated shape, with the gate's heap,
// the candidate exits 0, finds every event and prints the oversized-file
// warning, and the baseline (the current release) runs out of memory. Returns
// what broke it, run by run.
export function gateFailures(runs, { heap, scale }) {
  const offSpec = [
    ...(heap === GATE_HEAP_MB
      ? []
      : [
          `--heap ${heap} is not the gate’s ${GATE_HEAP_MB}, so the check proves nothing`,
        ]),
    ...(scale === 1
      ? []
      : [`--scale ${scale} is not the gate’s 1, so the check proves nothing`]),
  ];
  const failures = runs.flatMap((run) => {
    const who = `${run.build} on Node ${run.nodeVersion}`;
    if (run.build === 'baseline') {
      return run.outOfMemory
        ? []
        : [`${who} did not run out of memory, so the check proves nothing`];
    }
    if (run.outOfMemory) {
      return [`${who} ran out of memory`];
    }
    return [
      ...(run.exitCode === 0 ? [] : [`${who} exited ${run.exitCode}, not 0`]),
      // Against the repo's own count, so a build that read only part of the
      // event map can't pass.
      ...(run.eventsSeen === EVENT_COUNT && run.eventsTotal === EVENT_COUNT
        ? []
        : [
            `${who} found ${run.eventsSeen} of ${run.eventsTotal} events, not ${EVENT_COUNT} of ${EVENT_COUNT}`,
          ]),
      ...(run.warnings.some((warning) =>
        warning.includes(`over the ${SIZE_CAP_BYTES / MIB} MiB size cap`),
      )
        ? []
        : [`${who} printed no oversized-file warning`]),
    ];
  });
  const missing = ['candidate', 'baseline']
    .filter((build) => !runs.some((run) => run.build === build))
    .map((build) => `no ${build} run, so the check proves nothing`);
  return [...offSpec, ...failures, ...missing];
}

// Everything below runs the check; it is exercised by running the script.

const log = (message) => console.error(`[large-repo-check] ${message}`);

const parseArgs = (args) => {
  const options = {
    shape: 'gated',
    nodes: [],
    candidate: fileURLToPath(new URL('../cli.js', import.meta.url)),
    baseline: null,
    heap: GATE_HEAP_MB,
    timeoutMinutes: 30,
    scale: 1,
    out: null,
  };
  const setters = {
    '--shape': (value) => {
      options.shape = value;
    },
    '--node': (value) => {
      options.nodes.push(value);
    },
    '--candidate': (value) => {
      options.candidate = path.resolve(value);
    },
    '--baseline': (value) => {
      options.baseline = path.resolve(value);
    },
    '--heap': (value) => {
      options.heap = Number(value);
    },
    '--timeout': (value) => {
      options.timeoutMinutes = Number(value);
    },
    '--scale': (value) => {
      options.scale = Number(value);
    },
    '--out': (value) => {
      options.out = path.resolve(value);
    },
  };
  for (let index = 0; index < args.length; index += 2) {
    const setter = setters[args[index]];
    if (setter === undefined || args[index + 1] === undefined) {
      throw new Error(
        `Unexpected argument '${args[index]}'; see the comment at the top of this script`,
      );
    }
    setter(args[index + 1]);
  }
  if (!SHAPE_NAMES.includes(options.shape)) {
    throw new Error(`--shape must be one of ${SHAPE_NAMES.join(', ')}`);
  }
  if (options.nodes.length === 0) {
    options.nodes.push(process.execPath);
  }
  return options;
};

const commandOutput = (command, args, cwd) => {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch (error) {
    return null;
  }
};

// Which avo a cli.js is, from the package.json next to it. Shown on every run,
// as the gate trusts --baseline to be the current release.
const buildVersion = (cli) => {
  try {
    return `avo ${
      JSON.parse(
        fs.readFileSync(path.join(path.dirname(cli), 'package.json'), 'utf8'),
      ).version
    }`;
  } catch (error) {
    return 'unknown version';
  }
};

// The build's version, plus the commit when it sits at the top of a git
// checkout (a global install can sit inside someone else's checkout, such as
// nvm's).
const describeBuild = (cli, version) => {
  const dir = path.dirname(cli);
  const topLevel = commandOutput('git', ['rev-parse', '--show-toplevel'], dir);
  if (topLevel === null || fs.realpathSync(topLevel) !== fs.realpathSync(dir)) {
    return `\`${cli}\` (${version})`;
  }
  const commit = commandOutput('git', ['rev-parse', '--short', 'HEAD'], dir);
  const dirty = commandOutput('git', ['status', '--porcelain'], dir);
  return `\`${cli}\` (${version}, commit ${commit}${
    dirty ? ' + local changes' : ''
  })`;
};

const killGroup = (child) => {
  try {
    // Detached, so this reaches time's Node child too.
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    // Already gone.
  }
};

let currentChild = null;

const runStatus = ({ node, cli, projectFolder, heap, timeoutMinutes }) =>
  new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      FORCE_COLOR: '0',
      NO_UPDATE_NOTIFIER: '1',
      AVO_API_ORIGIN: 'http://127.0.0.1:9',
    };
    // Either would make cli.js skip its commands (its main-module guard).
    delete env.AVO_TEST_MODE;
    delete env.JEST_WORKER_ID;
    const child = spawn(
      '/usr/bin/time',
      ['-l', node, `--max-old-space-size=${heap}`, cli, 'status'],
      {
        cwd: projectFolder,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    currentChild = child;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        killGroup(child);
      },
      timeoutMinutes * 60 * 1000,
    );
    child.on('error', (error) => {
      clearTimeout(timer);
      currentChild = null;
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      currentChild = null;
      resolve({
        exitCode: code === null ? 128 + os.constants.signals[signal] : code,
        stdout,
        stderr,
        timedOut,
      });
    });
  });

const counted = (count, noun) => {
  const number = count.toLocaleString('en-US');
  if (noun === undefined) {
    return number;
  }
  return `${number} ${noun}${count === 1 ? '' : 's'}`;
};

const mib = (bytes) =>
  bytes === null
    ? '?'
    : `${Math.round(bytes / MIB).toLocaleString('en-US')} MiB`;

const outcomeOf = (run, timeoutMinutes) => {
  if (run.timedOut) {
    return `killed after ${timeoutMinutes} min`;
  }
  if (run.outOfMemory) {
    return `**out of memory** (exit ${run.exitCode})`;
  }
  return `exit ${run.exitCode}`;
};

const formatMarkdown = ({ options, repo, generationSeconds, builds, runs }) => {
  const ignoredFiles = Object.values(repo.counts.ignored).reduce(
    (total, count) => total + count,
    0,
  );
  const macos = commandOutput('sw_vers', ['-productVersion']);
  const gitVersion = commandOutput('git', ['--version']);
  const lines = [
    `### Large-repo check: ${options.shape} shape${
      options.shape === 'gated' ? '' : ' (informational, not gated)'
    }`,
    '',
    [
      `Repo: ${counted(ignoredFiles, 'ignored file')}`,
      `(${(repo.counts.ignoredBytes / 1024 ** 3).toFixed(2)} GiB:`,
      `${Object.entries(repo.counts.ignored)
        .map(([folder, count]) => `\`${folder}\` ${counted(count)}`)
        .join(', ')}),`,
      `${counted(repo.counts.e2eTests, 'untracked e2e test')},`,
      `${counted(repo.events.length, 'event')},`,
      `${counted(repo.counts.nearCap, 'file')} of 9.9 MiB,`,
      `${counted(repo.counts.oversized, 'oversized file')};`,
      `project folder \`${
        path.relative(repo.repoRoot, repo.projectFolder) || '.'
      }\` of the repo; generated in ${Math.round(generationSeconds)} s.`,
      ...(options.scale === 1
        ? []
        : [`**Scaled down ${options.scale}x: not the real check.**`]),
    ].join(' '),
    '',
    `Machine: macOS ${macos ?? os.release()}, ${os.cpus().length} CPUs, ${Math.round(
      os.totalmem() / 1024 ** 3,
    )} GB RAM, ${gitVersion}. Every run: \`--max-old-space-size=${options.heap}\`.`,
    '',
    ...builds.map(({ name, description }) => `- ${name}: ${description}`),
    '',
    '| Build | Node | Outcome | Events found | Warnings | Wall time | Peak RSS |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...runs.map((run) =>
      [
        '',
        `${run.build} (${run.buildVersion})`,
        run.nodeVersion,
        outcomeOf(run, options.timeoutMinutes),
        run.eventsTotal === null
          ? '–'
          : `${run.eventsSeen} of ${run.eventsTotal}`,
        run.warnings.length === 0 ? 'none' : run.warnings.join('<br>'),
        run.wallSeconds === null ? '?' : `${run.wallSeconds.toFixed(1)} s`,
        mib(run.peakRssBytes),
        '',
      ]
        .join(' | ')
        .trim(),
    ),
    '',
  ];
  if (options.shape === 'gated') {
    const failures = gateFailures(runs, options);
    lines.push(
      failures.length === 0
        ? 'Gate: **passed**.'
        : ['Gate: **failed**:', ...failures.map((f) => `- ${f}`)].join('\n'),
      '',
    );
  }
  return lines.join('\n');
};

const freeBytes = (dir) => {
  // fs.statfsSync needs Node 18.15; skip the check on older Node.
  if (typeof fs.statfsSync !== 'function') {
    return null;
  }
  const stats = fs.statfsSync(dir);
  return stats.bavail * stats.bsize;
};

async function main(args) {
  const options = parseArgs(args);
  const builds = [
    { name: 'candidate', cli: options.candidate },
    ...(options.baseline === null
      ? []
      : [{ name: 'baseline', cli: options.baseline }]),
  ].map((build) => {
    const version = buildVersion(build.cli);
    return {
      ...build,
      version,
      description: describeBuild(build.cli, version),
    };
  });
  const nodes = options.nodes.map((node) => ({
    node,
    nodeVersion: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(),
  }));

  const free = freeBytes(os.tmpdir());
  const needed = 3.5e9 / options.scale;
  if (free !== null && free < needed) {
    throw new Error(
      `${os.tmpdir()} has ${(free / 1e9).toFixed(1)} GB free; the repo needs about ${(
        needed / 1e9
      ).toFixed(1)} GB`,
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avo-large-repo-'));
  const cleanUp = () => {
    log(`Deleting ${tempRoot}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    if (currentChild !== null) {
      killGroup(currentChild);
    }
    cleanUp();
    process.exit(128 + os.constants.signals[signal]);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    log(`Generating the ${options.shape} repo in ${tempRoot}`);
    const started = Date.now();
    const repo = generateRepo(path.join(tempRoot, 'repo'), {
      shape: options.shape,
      scale: options.scale,
    });
    const generationSeconds = (Date.now() - started) / 1000;
    log(`Generated in ${generationSeconds.toFixed(1)} s`);

    const runs = [];
    // One at a time, so runs don't compete for memory or disk.
    // eslint-disable-next-line no-restricted-syntax
    for (const { node, nodeVersion } of nodes) {
      // eslint-disable-next-line no-restricted-syntax
      for (const build of builds) {
        log(`Running ${build.name} (${build.version}) on Node ${nodeVersion}`);
        // eslint-disable-next-line no-await-in-loop
        const result = await runStatus({
          node,
          cli: build.cli,
          projectFolder: repo.projectFolder,
          heap: options.heap,
          timeoutMinutes: options.timeoutMinutes,
        });
        const run = {
          build: build.name,
          buildVersion: build.version,
          nodeVersion,
          ...summariseRun(result),
          timedOut: result.timedOut,
        };
        log(
          `  ${outcomeOf(run, options.timeoutMinutes)}, ${
            run.eventsTotal === null
              ? 'no'
              : `${run.eventsSeen} of ${run.eventsTotal}`
          } events, ${run.wallSeconds} s, ${mib(run.peakRssBytes)}`,
        );
        runs.push(run);
      }
    }

    const markdown = formatMarkdown({
      options,
      repo,
      generationSeconds,
      builds,
      runs,
    });
    process.stdout.write(markdown);
    if (options.out !== null) {
      fs.writeFileSync(options.out, markdown);
    }
    return options.shape === 'gated' && gateFailures(runs, options).length > 0
      ? 1
      : 0;
  } finally {
    cleanUp();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;

if (isMainModule) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      log(error.stack ?? String(error));
      process.exitCode = 2;
    },
  );
}
