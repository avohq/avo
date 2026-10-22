import fs from 'fs';
import path from 'path';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { status, SIZE_CAP_BYTES, READ_CONCURRENCY } from './cli.js';
import {
  useGitSandbox,
  git,
  initRepo,
  commitAll,
  writeFiles,
} from './gitFixture.js';

const MiB = 1024 * 1024;

const avoFile = (events: string[]): string =>
  `// AVOEVENTMAP: ${JSON.stringify(events)}\n`;

const avoJson = (sources: { name: string; path: string }[]) => ({ sources });

const WEB = { name: 'Web', path: 'Avo.ts' };

// Creates a file of exactly `size` bytes without holding it in memory
const writeSizedFile = (file: string, size: number, content = ''): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.truncateSync(file, size);
};

// Paths passed to fs.readFile / fs.lstat, relative to the cwd
const calledPaths = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map(([file]) => String(file));

describe('status', () => {
  const sandbox = useGitSandbox();
  let logs: string[];
  let exitSpy;
  let readSpy;
  let lstatSpy;

  beforeEach(() => {
    logs = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    readSpy = jest.spyOn(fs, 'readFile');
    lstatSpy = jest.spyOn(fs, 'lstat');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const warnings = (): string[] =>
    logs
      .filter((line) => line.startsWith('warn '))
      .map((line) => line.substring('warn '.length));

  const run = (
    json = avoJson([WEB]),
    argv: { verbose?: boolean } = {},
  ): Promise<void> => status(undefined, json, { verbose: false, ...argv });

  // A repo whose project folder is the repo root, with Avo.ts and a src file
  // calling every event, all committed
  const setUpRepo = (
    events = ['signedUp', 'loggedIn'],
    files: { [file: string]: string } = {},
  ): string => {
    const repo = initRepo(path.join(sandbox.root(), 'repo'));
    writeFiles(repo, {
      'Avo.ts': avoFile(events),
      'src/app.ts': events.map((event) => `Avo.${event}();\n`).join(''),
      ...files,
    });
    commitAll(repo);
    process.chdir(repo);
    return repo;
  };

  describe('tracked files that match an ignore rule', () => {
    it('warns once with a count when one of them matches an effective glob', async () => {
      const repo = setUpRepo(['signedUp'], {
        'src/generated.ts': 'Avo.signedUp();\n',
        'src/old.ts': '',
        'notes.txt': '',
      });
      writeFiles(repo, {
        '.gitignore': 'generated.ts\nold.ts\nnotes.txt\n',
      });

      await run();

      expect(warnings()).toEqual([
        'Skipped 2 tracked files that match an ignore rule; run with --verbose to list them.',
      ]);
      expect(calledPaths(readSpy)).not.toContain('src/generated.ts');
    });

    it('lists their paths under --verbose', async () => {
      const repo = setUpRepo(['signedUp'], { 'src/generated.ts': '' });
      writeFiles(repo, { '.gitignore': 'generated.ts\n' });

      await run(undefined, { verbose: true });

      expect(warnings()).toEqual([
        'Skipped 1 tracked file that matches an ignore rule:\nsrc/generated.ts',
      ]);
    });

    it('does not warn when none of them matches an effective glob', async () => {
      const repo = setUpRepo(['signedUp'], { 'notes.txt': '' });
      writeFiles(repo, { '.gitignore': 'notes.txt\n' });

      await run();

      expect(warnings()).toEqual([]);
    });
  });

  describe('falling back to the walker', () => {
    it('warns once with the reason, and still applies the size cap', async () => {
      const dir = path.join(sandbox.root(), 'project');
      writeFiles(dir, {
        'Avo.ts': avoFile(['signedUp']),
        'src/app.ts': 'Avo.signedUp();\n',
      });
      writeSizedFile(path.join(dir, 'src/bundle.ts'), SIZE_CAP_BYTES + 1);
      process.chdir(dir);

      await run();

      expect(warnings()).toEqual([
        'Could not list files with git (git exited with code 128: fatal: not a git repository (or any of the parent directories): .git), so the folder was walked instead and only .gitignore files in it were applied.',
        'Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
      ]);
      expect(calledPaths(readSpy)).not.toContain('src/bundle.ts');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('the size cap', () => {
    it('never reads an oversized file, and counts it in the warning', async () => {
      setUpRepo(['signedUp']);
      writeSizedFile('src/vendor/bundle.min.js', Math.round(14.2 * MiB));
      writeSizedFile('src/huge.ts', 20 * MiB);

      await run();

      expect(warnings()).toEqual([
        'Skipped 2 files over the 10 MiB size cap; run with --verbose to list them.',
      ]);
      expect(calledPaths(readSpy)).not.toContain('src/vendor/bundle.min.js');
      expect(calledPaths(readSpy)).not.toContain('src/huge.ts');
    });

    it('lists each oversized file with its size in MiB under --verbose', async () => {
      setUpRepo(['signedUp']);
      writeSizedFile('src/vendor/bundle.min.js', Math.round(14.2 * MiB));
      writeSizedFile('src/huge.ts', 20 * MiB);

      await run(undefined, { verbose: true });

      expect(warnings()).toContain(
        'Skipped 2 files over the 10 MiB size cap:\nsrc/huge.ts (20.0 MiB)\nsrc/vendor/bundle.min.js (14.2 MiB)',
      );
    });

    it('reads a file of exactly 10 MiB, and skips one of 10 MiB and 1 byte', async () => {
      setUpRepo(['signedUp']);
      writeSizedFile('src/at-cap.ts', SIZE_CAP_BYTES, 'Avo.signedUp();\n');
      writeSizedFile('src/over-cap.ts', SIZE_CAP_BYTES + 1);

      await run();

      expect(calledPaths(readSpy)).toContain('src/at-cap.ts');
      expect(calledPaths(readSpy)).not.toContain('src/over-cap.ts');
      expect(warnings()).toEqual([
        'Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
      ]);
      expect(logs.join('\n')).toContain('used in src/at-cap.ts: 1 time');
    });

    it('counts a file matched by two sources once', async () => {
      setUpRepo(['signedUp'], {
        'Other.ts': avoFile(['opened']),
        'src/other.ts': 'Other.opened();\n',
      });
      writeSizedFile('src/bundle.ts', SIZE_CAP_BYTES + 1);

      await run(avoJson([WEB, { name: 'Other', path: 'Other.ts' }]));

      expect(warnings()).toEqual([
        'Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
      ]);
    });

    it('reports an event whose only usage is in an oversized file as missing, and exits 1', async () => {
      setUpRepo(['signedUp', 'loggedIn'], {
        'src/app.ts': 'Avo.signedUp();\n',
      });
      writeSizedFile('src/bundle.ts', SIZE_CAP_BYTES + 1, 'Avo.loggedIn();\n');

      await run();

      expect(warnings()).toEqual([
        'Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
      ]);
      expect(logs.join('\n')).toContain('loggedIn: no usage found');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('never checks or warns about a huge file that no effective glob matches', async () => {
      setUpRepo(['signedUp']);
      writeSizedFile('assets/video.bin', 20 * MiB);

      await run();

      expect(warnings()).toEqual([]);
      expect(calledPaths(lstatSpy)).not.toContain('assets/video.bin');
      expect(calledPaths(readSpy)).not.toContain('assets/video.bin');
    });
  });

  describe('reading', () => {
    it('keeps the "used in" lines and the --verbose file list in listing order', async () => {
      const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
      setUpRepo(
        ['signedUp'],
        Object.fromEntries(files.map((file) => [file, 'Avo.signedUp();\n'])),
      );
      fs.rmSync('src/app.ts');

      // Each read finishes later than the one started after it
      readSpy.mockRestore();
      const original = fs.readFile;
      let started = 0;
      readSpy = jest.spyOn(fs, 'readFile').mockImplementation(((
        file,
        options,
        callback,
      ) => {
        const delay = (20 - started) * 10;
        started += 1;
        original(file, options, (error, data) =>
          setTimeout(() => callback(error, data), delay),
        );
      }) as typeof fs.readFile);

      await run(undefined, { verbose: true });

      const lookingIn = logs.find((line) =>
        line.startsWith('info Looking in files: '),
      );
      expect(lookingIn).toBe(`info Looking in files: ${files.join('\n')}`);
      const tree = logs.find((line) => line.startsWith('sources'));
      const usedIn = tree
        .split('\n')
        .filter((line) => line.includes('used in'))
        .map((line) => line.replace(/^.*used in /, ''));
      expect(usedIn).toEqual(files.map((file) => `${file}: 1 time`));
    });

    it(`never has more than ${READ_CONCURRENCY} reads in flight`, async () => {
      const files = Object.fromEntries(
        Array.from({ length: READ_CONCURRENCY * 3 }, (_, index) => [
          `src/file${index}.ts`,
          'Avo.signedUp();\n',
        ]),
      );
      setUpRepo(['signedUp'], files);

      readSpy.mockRestore();
      const original = fs.readFile;
      let inFlight = 0;
      let maxInFlight = 0;
      readSpy = jest.spyOn(fs, 'readFile').mockImplementation(((
        file,
        options,
        callback,
      ) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        original(file, options, (error, data) =>
          setTimeout(() => {
            inFlight -= 1;
            callback(error, data);
          }, 5),
        );
      }) as typeof fs.readFile);

      await run();

      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(READ_CONCURRENCY);
    });

    it('skips symlinks', async () => {
      setUpRepo(['signedUp']);
      fs.symlinkSync('app.ts', 'src/link.ts');

      await run();

      const output = logs.join('\n');
      expect(output).toContain('used in src/app.ts: 1 time');
      expect(output).not.toContain('src/link.ts');
      expect(calledPaths(readSpy)).not.toContain('src/link.ts');
    });

    it('tolerates files deleted from disk and files left out by a sparse checkout', async () => {
      const repo = setUpRepo(['signedUp'], {
        'src/deleted.ts': 'Avo.signedUp();\n',
        'other/sparse.ts': 'Avo.signedUp();\n',
      });
      git(repo, 'sparse-checkout', 'set', '--no-cone', '/*', '!/other/');
      expect(fs.existsSync('other/sparse.ts')).toBe(false);
      fs.rmSync('src/deleted.ts');

      await run();

      const output = logs.join('\n');
      expect(output).toContain('used in src/app.ts: 1 time');
      expect(output).not.toContain('src/deleted.ts');
      expect(output).not.toContain('other/sparse.ts');
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it('leaves the exit code unchanged when there are only warnings', async () => {
    const repo = setUpRepo(['signedUp'], { 'src/generated.ts': '' });
    writeFiles(repo, { '.gitignore': 'generated.ts\n' });
    writeSizedFile('src/bundle.ts', SIZE_CAP_BYTES + 1);

    await run();

    expect(warnings()).toEqual([
      'Skipped 1 tracked file that matches an ignore rule; run with --verbose to list it.',
      'Skipped 1 file over the 10 MiB size cap; run with --verbose to list it.',
    ]);
    expect(logs.join('\n')).toContain('1 events seen in code');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
