import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { describe, it, expect, jest } from '@jest/globals';
import {
  gateFailures,
  generateRepo,
  summariseRun,
} from './large-repo-check.js';
import { git, useIsolatedGit } from '../testGit.js';

// One test generates the full-size files around the size cap (about 50 MiB),
// which git hashes on commit.
jest.setTimeout(30000);

// The repos are generated at a tiny scale: the same shape, with a few files
// standing in for each 1000s of them. Apart from the size-cap test, the files
// around the cap are sized against a small cap, which keeps the tests cheap.
const TINY = { scale: 5000, sizeCap: 10 * 1024 };

const MIB = 1024 * 1024;

const lsFiles = (cwd: string, ...args: string[]): string[] =>
  git(cwd, 'ls-files', '-z', ...args)
    .split('\0')
    .filter((filePath) => filePath !== '');

// Every file outside .git, with a hash of its contents, relative to `dir`.
function manifest(dir: string, prefix = ''): string[] {
  return fs
    .readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .filter((entry) => !(prefix === '' && entry.name === '.git'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        return manifest(dir, relative);
      }
      const hash = crypto
        .createHash('sha1')
        .update(fs.readFileSync(path.join(dir, relative)))
        .digest('hex');
      return [`${relative} ${hash}`];
    });
}

function countFiles(dir: string): number {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce(
      (total, entry) =>
        total +
        (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1),
      0,
    );
}

// What `/usr/bin/time -l` appends to stderr on macOS (trimmed), from real runs.
const timeOutput = (real: string, rss: string): string =>
  [
    `        ${real} real         0.98 user         0.38 sys`,
    `           ${rss}  maximum resident set size`,
    '                   0  average shared memory size',
    '            65126720  peak memory footprint',
    '',
  ].join('\n');

describe('generateRepo', () => {
  const tempRoot = useIsolatedGit('avo-large-repo-test-');

  // Both shapes share every writer, so one shape covers it.
  it('generates the same repo on every run, down to the commit', () => {
    const first = generateRepo(path.join(tempRoot(), 'first'), {
      shape: 'gated',
      ...TINY,
    });
    const second = generateRepo(path.join(tempRoot(), 'second'), {
      shape: 'gated',
      ...TINY,
    });

    expect(manifest(second.repoRoot)).toEqual(manifest(first.repoRoot));
    expect(git(second.repoRoot, 'rev-parse', 'HEAD')).toBe(
      git(first.repoRoot, 'rev-parse', 'HEAD'),
    );
  });

  describe('the gated shape', () => {
    it('puts the project folder below a repo root whose .gitignore hides the big folders from git', () => {
      const repoRoot = path.join(tempRoot(), 'repo');

      const repo = generateRepo(repoRoot, { shape: 'gated', ...TINY });

      expect(repo.projectFolder).toBe(path.join(repoRoot, 'app'));
      const listed = lsFiles(
        repo.projectFolder,
        '--cached',
        '--others',
        '--exclude-standard',
      );
      expect(listed).toEqual(expect.arrayContaining(['avo.json', 'Avo.ts']));
      expect(
        listed.filter((filePath) =>
          /^(node_modules|ios\/Pods|ios\/build|android\/app\/\.cxx|android\/\.gradle)\//.test(
            filePath,
          ),
        ),
      ).toEqual([]);
      // The source is committed; the e2e tests are untracked.
      const tracked = lsFiles(repo.projectFolder, '--cached');
      expect(
        tracked.filter((filePath) => filePath.startsWith('src/')),
      ).not.toEqual([]);
      expect(
        tracked.filter((filePath) => filePath.startsWith('tests/e2e-tests/')),
      ).toEqual([]);
      expect(
        listed.filter((filePath) => filePath.startsWith('tests/e2e-tests/')),
      ).toHaveLength(repo.counts.e2eTests);
      expect(repo.counts.e2eTests).toBeGreaterThan(0);
      // The ignored folders are on disk, for a walker to find.
      Object.entries(repo.counts.ignored).forEach(([folder, count]) => {
        expect(count).toBeGreaterThan(0);
        expect(countFiles(path.join(repo.projectFolder, folder))).toBe(count);
      });
    });

    it('keeps the near-cap files at or under the size cap, the oversized files over it, and every event called from a file under it', () => {
      // At status's own cap: the only test that writes the full-size files.
      const repo = generateRepo(path.join(tempRoot(), 'repo'), {
        shape: 'gated',
        scale: TINY.scale,
      });

      const src = path.join(repo.projectFolder, 'src');
      const sizes = (folder: string): number[] =>
        fs
          .readdirSync(path.join(src, folder))
          .map((name) => fs.statSync(path.join(src, folder, name)).size);
      const nearCap = sizes('generated');
      expect(nearCap).toHaveLength(repo.counts.nearCap);
      nearCap.forEach((size) => {
        expect(size).toBeGreaterThanOrEqual(9.9 * MIB - 1);
        expect(size).toBeLessThanOrEqual(10 * MIB);
      });
      const oversized = sizes('vendor');
      expect(oversized).toHaveLength(3);
      oversized.forEach((size) => {
        expect(size).toBeGreaterThan(10 * MIB);
      });

      const underTheCap = ['events', 'generated']
        .flatMap((folder) =>
          fs
            .readdirSync(path.join(src, folder))
            .map((name) => path.join(src, folder, name)),
        )
        .map((filePath) => fs.readFileSync(filePath, 'utf8'))
        .join('\n');
      const eventMap = JSON.parse(
        /AVOEVENTMAP:(\[.*\])/.exec(
          fs.readFileSync(path.join(repo.projectFolder, 'Avo.ts'), 'utf8'),
        )[1],
      );
      expect(eventMap).toEqual(repo.events);
      expect(eventMap.length).toBeGreaterThan(1);
      eventMap.forEach((event: string) => {
        expect(underTheCap).toContain(`Avo.${event}(`);
      });
    });
  });

  describe('the reporter shape', () => {
    it('puts the project folder at the repo root, with the stand-in for the #610 reporter’s .gitignore and nested node_modules git ignores', () => {
      const repoRoot = path.join(tempRoot(), 'repo');

      const repo = generateRepo(repoRoot, { shape: 'reporter', ...TINY });

      expect(repo.projectFolder).toBe(repoRoot);
      expect(fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')).toBe(
        fs.readFileSync(
          new URL('reporter-610.gitignore', import.meta.url),
          'utf8',
        ),
      );
      const listed = lsFiles(
        repoRoot,
        '--cached',
        '--others',
        '--exclude-standard',
      );
      expect(listed).toEqual(expect.arrayContaining(['avo.json', 'Avo.ts']));
      expect(
        listed.filter((filePath) =>
          /(^|\/)node_modules\/|^ios\/Pods\/|^ios\/build\/|^android\/app\/\.cxx\/|^android\/\.gradle\//.test(
            filePath,
          ),
        ),
      ).toEqual([]);
      expect(
        listed.filter((filePath) => filePath.startsWith('tests/e2e-tests/')),
      ).toHaveLength(repo.counts.e2eTests);
      const nested = Object.keys(repo.counts.ignored).filter((folder) =>
        /.\/node_modules$/.test(folder),
      );
      expect(nested).toEqual(
        expect.arrayContaining(['tests/e2e-tests/node_modules']),
      );
      expect(
        nested.filter((folder) =>
          /^packages\/[^/]+\/node_modules$/.test(folder),
        ).length,
      ).toBeGreaterThan(1);
      Object.entries(repo.counts.ignored).forEach(([folder, count]) => {
        expect(count).toBeGreaterThan(0);
        expect(countFiles(path.join(repo.projectFolder, folder))).toBe(count);
      });
    });
  });
});

describe('summariseRun', () => {
  it('reads the exit code, events seen, warnings, wall time and peak RSS of a finished run', () => {
    const stdout = [
      "info Currently on branch 'main'",
      'warn Skipped 3 files over the 10 MiB size cap; run with --verbose to list them.',
      'sources',
      '└─ App (Avo.ts)',
      '   └─ largeRepoEvent20',
      '      └─ used in src/events/largeRepoEvent20.ts: 1 time',
      '',
      'info 20 events seen in code',
      '',
    ].join('\n');

    expect(
      summariseRun({
        exitCode: 0,
        stdout,
        stderr: timeOutput('1.06', '218382336'),
      }),
    ).toEqual({
      exitCode: 0,
      outOfMemory: false,
      eventsSeen: 20,
      eventsTotal: 20,
      warnings: [
        'Skipped 3 files over the 10 MiB size cap; run with --verbose to list them.',
      ],
      wallSeconds: 1.06,
      peakRssBytes: 218382336,
    });
  });

  it('counts the events seen when some are missing', () => {
    const stdout = [
      "info Currently on branch 'main'",
      'info 19 of 20 events seen in code',
      'error 1 missing event',
      '',
    ].join('\n');

    expect(
      summariseRun({
        exitCode: 1,
        stdout,
        stderr: timeOutput('3.50', '300000000'),
      }),
    ).toMatchObject({
      exitCode: 1,
      outOfMemory: false,
      eventsSeen: 19,
      eventsTotal: 20,
      warnings: [],
    });
  });

  it('spots a run that ran out of memory, on Node 14 and on later versions', () => {
    ['Ineffective mark-compacts near heap limit', 'Reached heap limit'].forEach(
      (reason) => {
        const stderr = [
          '<--- Last few GCs --->',
          '',
          `FATAL ERROR: ${reason} Allocation failed - JavaScript heap out of memory`,
          ' 1: 0x1008811fc node::OOMErrorHandler(char const*, v8::OOMDetails const&)',
          'time: command terminated abnormally',
          timeOutput('41.20', '2539421696'),
        ].join('\n');

        expect(
          summariseRun({
            exitCode: 134,
            stdout: "info Currently on branch 'main'\n",
            stderr,
          }),
        ).toEqual({
          exitCode: 134,
          outOfMemory: true,
          eventsSeen: null,
          eventsTotal: null,
          warnings: [],
          wallSeconds: 41.2,
          peakRssBytes: 2539421696,
        });
      },
    );
  });
});

describe('gateFailures', () => {
  const passingCandidate = {
    build: 'candidate',
    nodeVersion: 'v14.18.1',
    exitCode: 0,
    outOfMemory: false,
    eventsSeen: 20,
    eventsTotal: 20,
    warnings: [
      'Skipped 3 files over the 10 MiB size cap; run with --verbose to list them.',
    ],
    wallSeconds: 20,
    peakRssBytes: 600000000,
  };
  const outOfMemoryBaseline = {
    build: 'baseline',
    nodeVersion: 'v14.18.1',
    exitCode: 134,
    outOfMemory: true,
    eventsSeen: null,
    eventsTotal: null,
    warnings: [],
    wallSeconds: 40,
    peakRssBytes: 2500000000,
  };
  // The options every gated run uses.
  const gateOptions = { heap: 2048, scale: 1 };

  it('holds when the candidate finds every event with the oversized-file warning and the baseline runs out of memory', () => {
    expect(
      gateFailures([passingCandidate, outOfMemoryBaseline], gateOptions),
    ).toEqual([]);
  });

  it('names every way a run broke the gate', () => {
    expect(
      gateFailures(
        [
          {
            ...passingCandidate,
            exitCode: 1,
            eventsSeen: 19,
            warnings: [],
          },
          {
            ...outOfMemoryBaseline,
            nodeVersion: 'v23.3.0',
            exitCode: 0,
            outOfMemory: false,
          },
          { ...passingCandidate, nodeVersion: 'v23.3.0', outOfMemory: true },
        ],
        gateOptions,
      ),
    ).toEqual([
      'candidate on Node v14.18.1 exited 1, not 0',
      'candidate on Node v14.18.1 found 19 of 20 events',
      'candidate on Node v14.18.1 printed no oversized-file warning',
      'baseline on Node v23.3.0 did not run out of memory, so the check proves nothing',
      'candidate on Node v23.3.0 ran out of memory',
    ]);
  });

  it('fails without both a candidate and a baseline run', () => {
    expect(gateFailures([passingCandidate], gateOptions)).toEqual([
      'no baseline run, so the check proves nothing',
    ]);
  });

  // The spec runs every gated run on a 2048 MB heap; --heap is for trying
  // the script out.
  it('fails runs on any heap but the gate’s, however they went', () => {
    expect(
      gateFailures([passingCandidate, outOfMemoryBaseline], {
        heap: 4096,
        scale: 1,
      }),
    ).toEqual([
      '--heap 4096 is not the gate’s 2048, so the check proves nothing',
    ]);
  });

  // Likewise, only the full-size repo is the check; --scale tries it out.
  it('fails runs on a scaled-down repo, however they went', () => {
    expect(
      gateFailures([passingCandidate, outOfMemoryBaseline], {
        heap: 2048,
        scale: 100,
      }),
    ).toEqual(['--scale 100 is not the gate’s 1, so the check proves nothing']);
  });
});
