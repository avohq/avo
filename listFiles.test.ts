import fs from 'fs';
import path from 'path';
import { describe, it, expect } from '@jest/globals';
import { listFiles } from './listFiles.js';
import {
  useGitSandbox,
  git,
  gitAllowingFailure,
  initRepo,
  commitAll,
  writeFiles,
} from './gitFixture.js';

describe('listFiles', () => {
  const sandbox = useGitSandbox();

  describe('with git', () => {
    it('applies a .gitignore above the project folder', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, {
        '.gitignore': 'node_modules/\n',
        'app/src/a.ts': '',
        'app/node_modules/lib/index.js': '',
      });
      process.chdir(path.join(repo, 'app'));

      expect(await listFiles()).toEqual({
        files: ['src/a.ts'],
        trackedIgnored: [],
      });
    });

    it('applies .git/info/exclude and the global core.excludesFile', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      const globalExcludes = path.join(sandbox.root(), 'global-excludes');
      fs.writeFileSync(globalExcludes, 'Pods/\n');
      git(repo, 'config', '--global', 'core.excludesFile', globalExcludes);
      fs.appendFileSync(path.join(repo, '.git/info/exclude'), 'build/\n');
      writeFiles(repo, {
        'src/a.ts': '',
        'ios/Pods/Lib/lib.m': '',
        'ios/build/out.js': '',
      });
      process.chdir(repo);

      expect((await listFiles()).files).toEqual(['src/a.ts']);
    });

    it('keeps an ignored folder ignored when a negation line names something inside it', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, {
        '.gitignore': 'node_modules/\n!node_modules/x\n!**/x\n',
        'src/a.ts': '',
        'node_modules/x/index.js': '',
        'node_modules/y/index.js': '',
      });
      process.chdir(repo);

      expect((await listFiles()).files).toEqual(['.gitignore', 'src/a.ts']);
    });

    it('matches trailing-slash rules at any depth', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, {
        '.gitignore': 'build/\n.cxx/\nnode_modules/\n',
        'src/a.ts': '',
        'ios/build/a.js': '',
        'android/app/.cxx/b.js': '',
        'packages/p/node_modules/c.js': '',
      });
      process.chdir(repo);

      expect((await listFiles()).files).toEqual(['.gitignore', 'src/a.ts']);
    });

    it('ignores the repo location git exports to hooks', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { 'app/src/a.ts': '', 'other.ts': '' });
      commitAll(repo);
      process.chdir(path.join(repo, 'app'));

      // As in a pre-commit hook run from the repo root that runs
      // `cd app && avo status`
      process.env.GIT_DIR = '.git';
      process.env.GIT_INDEX_FILE = path.join(repo, '.git/index');
      process.env.GIT_PREFIX = '';
      let listing;
      try {
        listing = await listFiles();
      } finally {
        delete process.env.GIT_DIR;
        delete process.env.GIT_INDEX_FILE;
        delete process.env.GIT_PREFIX;
      }

      expect(listing).toEqual({ files: ['src/a.ts'], trackedIgnored: [] });
    });

    it('lists .github/ and .gitlab-ci.yml but nothing under .git/', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, {
        '.github/workflows/ci.yml': '',
        '.gitlab-ci.yml': '',
      });
      commitAll(repo);
      process.chdir(repo);

      expect((await listFiles()).files).toEqual([
        '.github/workflows/ci.yml',
        '.gitlab-ci.yml',
      ]);
    });

    it('lists tracked files and untracked files that are not ignored', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { 'src/tracked.ts': '' });
      commitAll(repo);
      writeFiles(repo, { 'src/untracked.ts': '' });
      process.chdir(repo);

      expect((await listFiles()).files).toEqual([
        'src/tracked.ts',
        'src/untracked.ts',
      ]);
    });

    it('returns tracked files that match an ignore rule separately, and does not list them', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { 'src/a.ts': '', 'src/generated.ts': '' });
      commitAll(repo);
      writeFiles(repo, { '.gitignore': 'generated.ts\n' });
      process.chdir(repo);

      expect(await listFiles()).toEqual({
        files: ['.gitignore', 'src/a.ts'],
        trackedIgnored: ['src/generated.ts'],
      });
    });

    describe('submodules', () => {
      // lib (with its own tracked-but-ignored file) holds a nested submodule;
      // app holds lib, plus a submodule that is never initialised
      const buildSubmodules = (): string => {
        const nested = initRepo(path.join(sandbox.root(), 'nested'));
        writeFiles(nested, { 'deep.ts': '' });
        commitAll(nested);

        const lib = initRepo(path.join(sandbox.root(), 'lib'));
        writeFiles(lib, { 'lib.ts': '', 'gen.ts': '' });
        commitAll(lib);
        writeFiles(lib, { '.gitignore': 'gen.ts\n' });
        git(lib, 'submodule', 'add', '-q', nested, 'vendor/nested');
        commitAll(lib);

        const other = initRepo(path.join(sandbox.root(), 'other'));
        writeFiles(other, { 'other.ts': '' });
        commitAll(other);

        const app = initRepo(path.join(sandbox.root(), 'app'));
        writeFiles(app, { 'src/a.ts': '' });
        git(app, 'submodule', 'add', '-q', lib, 'libs/lib');
        git(app, 'submodule', 'add', '-q', other, 'libs/other');
        git(app, 'submodule', 'update', '--init', '--recursive', '-q');
        commitAll(app);

        // A fresh clone that initialises only libs/lib, recursively
        const clone = path.join(sandbox.root(), 'clone');
        git(sandbox.root(), 'clone', '-q', app, clone);
        git(clone, 'submodule', 'update', '--init', '-q', 'libs/lib');
        git(
          path.join(clone, 'libs/lib'),
          'submodule',
          'update',
          '--init',
          '-q',
        );
        return clone;
      };

      it('lists nested submodules with a path prefix, and nothing for an uninitialised one', async () => {
        process.chdir(buildSubmodules());

        expect(await listFiles()).toEqual({
          files: [
            '.gitmodules',
            'libs/lib/.gitignore',
            'libs/lib/.gitmodules',
            'libs/lib/lib.ts',
            'libs/lib/vendor/nested/deep.ts',
            'src/a.ts',
          ],
          trackedIgnored: ['libs/lib/gen.ts'],
        });
      });
    });

    it('lists paths with non-ASCII characters and spaces exactly', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { 'src/événement.ts': '', 'src/my file.ts': '' });
      commitAll(repo);
      writeFiles(repo, { 'src/日本語 ファイル.ts': '' });
      process.chdir(repo);

      const { files } = await listFiles();

      expect(files).toEqual(
        expect.arrayContaining([
          'src/événement.ts',
          'src/my file.ts',
          'src/日本語 ファイル.ts',
        ]),
      );
      expect(files).toHaveLength(3);
      files.forEach((file) => expect(fs.existsSync(file)).toBe(true));
    });

    it('lists a path in a merge conflict once', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { 'a.ts': 'base\n' });
      commitAll(repo);
      git(repo, 'checkout', '-q', '-b', 'other');
      writeFiles(repo, { 'a.ts': 'other\n' });
      commitAll(repo);
      git(repo, 'checkout', '-q', 'main');
      writeFiles(repo, { 'a.ts': 'main\n' });
      commitAll(repo);
      gitAllowingFailure(repo, 'merge', '-q', 'other');
      expect(git(repo, 'ls-files', '--unmerged')).not.toBe('');
      process.chdir(repo);

      expect((await listFiles()).files).toEqual(['a.ts']);
    });

    it('copes with git output larger than 1 MB', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      const folder = path.join(repo, 'd'.repeat(150));
      fs.mkdirSync(folder);
      const count = 6000;
      for (let index = 0; index < count; index += 1) {
        fs.writeFileSync(
          path.join(folder, `${String(index).padStart(45, 'f')}.ts`),
          '',
        );
      }
      process.chdir(repo);

      const { files } = await listFiles();

      expect(files).toHaveLength(count);
      expect(files.join('\0').length).toBeGreaterThan(1024 * 1024);
    });

    it('returns the same listing order on every run', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { 'b.ts': '', 'A.ts': '', 'a/z.ts': '', 'é.ts': '' });
      commitAll(repo);
      writeFiles(repo, { 'c.ts': '', 'B.ts': '' });
      process.chdir(repo);

      const first = await listFiles();
      const second = await listFiles();

      expect(first.files).toEqual([
        'A.ts',
        'B.ts',
        'a/z.ts',
        'b.ts',
        'c.ts',
        'é.ts',
      ]);
      expect(second).toEqual(first);
    });
  });

  describe('falling back to the walker', () => {
    it('falls back when git is not installed', async () => {
      const dir = path.join(sandbox.root(), 'project');
      writeFiles(dir, { 'src/a.ts': '' });
      const emptyBin = path.join(sandbox.root(), 'empty-bin');
      fs.mkdirSync(emptyBin);
      process.chdir(dir);

      const previousPath = process.env.PATH;
      process.env.PATH = emptyBin;
      let listing;
      try {
        listing = await listFiles();
      } finally {
        process.env.PATH = previousPath;
      }

      expect(listing).toEqual({
        files: ['src/a.ts'],
        trackedIgnored: [],
        fallbackReason: 'git is not installed',
      });
    });

    it('falls back outside a git repo', async () => {
      const dir = path.join(sandbox.root(), 'project');
      writeFiles(dir, { 'src/a.ts': '', '.gitignore': 'ignored.ts\n' });
      writeFiles(dir, { 'ignored.ts': '' });
      process.chdir(dir);

      expect(await listFiles()).toEqual({
        files: ['src/a.ts'],
        trackedIgnored: [],
        fallbackReason:
          'git exited with code 128: fatal: not a git repository (or any of the parent directories): .git',
      });
    });

    it('falls back when the project folder itself is ignored by git', async () => {
      const repo = initRepo(path.join(sandbox.root(), 'repo'));
      writeFiles(repo, { '.gitignore': 'app/\n', 'app/src/a.ts': '' });
      process.chdir(path.join(repo, 'app'));

      expect(await listFiles()).toEqual({
        files: ['src/a.ts'],
        trackedIgnored: [],
        fallbackReason: 'the project folder is ignored by git',
      });
    });
  });
});
