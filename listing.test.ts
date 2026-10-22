import fs from 'fs';
import path from 'path';
import { describe, it, expect, jest } from '@jest/globals';
import { listFiles, splitRepoEntries } from './listing.js';
import { commitAll, git, useIsolatedGit } from './testGit.js';

// Building a fixture with submodules runs a few dozen git commands, which
// takes 2-3 s on a Mac; leave room above jest's 5 s default on slower machines.
jest.setTimeout(20000);

// Every test runs real git against repos built in a temp folder, isolated from
// the developer's machine.
const tempRoot = useIsolatedGit('avo-listing-');

const write = (filePath: string, contents = ''): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
};

// Creates an empty file at each path, relative to `dir`.
const touch = (dir: string, ...paths: string[]): void => {
  paths.forEach((filePath) => write(path.join(dir, filePath)));
};

const initRepo = (name: string): string => {
  const dir = path.join(tempRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  return dir;
};

// git 2.38.1 and later refuse local-path submodules unless file transport is
// allowed. `-c` reaches the nested clones too.
const gitAllowingFileSubmodules = (cwd: string, ...args: string[]): string =>
  git(cwd, '-c', 'protocol.file.allow=always', ...args);

// Builds a repo with one committed file, to be added as a submodule.
const initSubmoduleSource = (name: string, ...paths: string[]): string => {
  const dir = initRepo(name);
  touch(dir, ...paths);
  commitAll(dir);
  return dir;
};

describe('listFiles', () => {
  describe('with git', () => {
    it('lists tracked files and untracked files that git does not ignore', async () => {
      const repo = initRepo('repo');
      write(path.join(repo, '.gitignore'), '*.log\n');
      touch(repo, 'tracked.ts');
      commitAll(repo);
      touch(repo, 'untracked.ts', 'debug.log');
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual([
        '.gitignore',
        'tracked.ts',
        'untracked.ts',
      ]);
      expect(listing.trackedButIgnored).toEqual([]);
      expect(listing.fallbackReason).toBeNull();
    });

    it('returns tracked files that match an ignore rule separately, and does not list them', async () => {
      const repo = initRepo('repo');
      touch(repo, 'src/app.ts', 'dist/bundle.js', 'dist/vendor.js');
      commitAll(repo);
      write(path.join(repo, '.gitignore'), 'dist/\n');
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual(['.gitignore', 'src/app.ts']);
      expect(listing.trackedButIgnored).toEqual([
        'dist/bundle.js',
        'dist/vendor.js',
      ]);
    });

    it('applies the repo root .gitignore below it and lists only the project folder, relative to it', async () => {
      const repo = initRepo('repo');
      write(path.join(repo, '.gitignore'), '*.log\ngenerated\n');
      touch(
        repo,
        'app/avo.json',
        'app/src/a.ts',
        'app/debug.log',
        'app/generated/x.ts',
        'other/b.ts',
      );
      commitAll(repo);
      touch(repo, 'app/src/untracked.ts', 'other/untracked.ts');
      process.chdir(path.join(repo, 'app'));

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual([
        'avo.json',
        'src/a.ts',
        'src/untracked.ts',
      ]);
    });

    it('applies rules from a parent folder .gitignore, .git/info/exclude and the global core.excludesFile', async () => {
      const repo = initRepo('repo');
      const globalIgnore = path.join(tempRoot(), 'home', 'global-ignore');
      write(globalIgnore, 'from-global.ts\n');
      git(repo, 'config', '--global', 'core.excludesFile', globalIgnore);
      write(path.join(repo, '.git', 'info', 'exclude'), 'from-exclude.ts\n');
      write(path.join(repo, 'packages', '.gitignore'), 'from-parent.ts\n');
      touch(
        repo,
        'packages/app/kept.ts',
        'packages/app/from-global.ts',
        'packages/app/from-exclude.ts',
        'packages/app/from-parent.ts',
      );
      process.chdir(path.join(repo, 'packages', 'app'));

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual(['kept.ts']);
    });

    it('keeps an ignored folder ignored when a negation line names a path inside it', async () => {
      const repo = initRepo('repo');
      write(
        path.join(repo, '.gitignore'),
        'node_modules/\n!node_modules/x.js\n!**/y.js\n',
      );
      touch(repo, 'src/a.ts', 'node_modules/x.js', 'node_modules/y.js');
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual(['.gitignore', 'src/a.ts']);
    });

    it('matches a trailing-slash rule against folders at any depth', async () => {
      const repo = initRepo('repo');
      write(path.join(repo, '.gitignore'), 'build/\n.cxx/\n');
      touch(
        repo,
        'src/a.ts',
        'build/a.ts',
        'ios/build/b.ts',
        'android/app/.cxx/c.ts',
        'docs/build',
      );
      process.chdir(repo);

      const listing = await listFiles();

      // `build/` only matches folders, so a file named `build` is still listed.
      expect(listing.listedFiles).toEqual([
        '.gitignore',
        'docs/build',
        'src/a.ts',
      ]);
    });

    it('lists .github/ and .gitlab-ci.yml, and nothing under .git/', async () => {
      const repo = initRepo('repo');
      touch(repo, '.github/workflows/ci.yml', '.gitlab-ci.yml', 'src/a.ts');
      commitAll(repo);
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual([
        '.github/workflows/ci.yml',
        '.gitlab-ci.yml',
        'src/a.ts',
      ]);
    });

    it('lists paths with non-ASCII characters and spaces exactly', async () => {
      const repo = initRepo('repo');
      touch(repo, 'src/dir with space/tracked ünï.ts');
      commitAll(repo);
      touch(repo, 'src/dir with space/untracked é.ts');
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual([
        'src/dir with space/tracked ünï.ts',
        'src/dir with space/untracked é.ts',
      ]);
    });

    it('lists a path in a merge conflict once', async () => {
      const repo = initRepo('repo');
      write(path.join(repo, 'a.ts'), 'base\n');
      commitAll(repo);
      const branch = git(repo, 'symbolic-ref', '--short', 'HEAD').trim();
      git(repo, 'checkout', '-q', '-b', 'other');
      write(path.join(repo, 'a.ts'), 'other\n');
      commitAll(repo);
      git(repo, 'checkout', '-q', branch);
      write(path.join(repo, 'a.ts'), 'mine\n');
      commitAll(repo);
      expect(() => git(repo, 'merge', '-q', 'other')).toThrow();
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing.listedFiles).toEqual(['a.ts']);
    });

    it('copes with git output over 1 MB', async () => {
      const repo = initRepo('repo');
      // 6,000 paths of about 200 bytes each come to about 1.2 MB of output,
      // over execFile's default 1 MB maxBuffer.
      const folder = path.join(repo, 'generated', 'd'.repeat(100));
      fs.mkdirSync(folder, { recursive: true });
      const fileName = (index: number): string =>
        `${'f'.repeat(90)}${String(index).padStart(4, '0')}.ts`;
      for (let index = 0; index < 6000; index += 1) {
        fs.writeFileSync(path.join(folder, fileName(index)), '');
      }
      process.chdir(repo);

      const listing = await listFiles();

      const prefix = `generated/${'d'.repeat(100)}`;
      expect(listing.listedFiles).toHaveLength(6000);
      expect(listing.listedFiles[0]).toBe(`${prefix}/${fileName(0)}`);
      expect(listing.listedFiles[5999]).toBe(`${prefix}/${fileName(5999)}`);
    });

    // git lists untracked files before tracked ones, and a submodule's files
    // come from a separate git call. Listing order sorts them all together by
    // UTF-16 code unit, which unlike localeCompare is the same on every
    // machine, so it doesn't depend on whether a file is committed yet.
    it('lists files in the same order on every run, whether tracked, untracked or in a submodule', async () => {
      const lib = initSubmoduleSource('lib', 'm.ts');
      const repo = initRepo('repo');
      touch(repo, 'b.ts', 'Z.ts');
      gitAllowingFileSubmodules(repo, 'submodule', 'add', '-q', lib, 'lib');
      commitAll(repo);
      touch(repo, 'é.ts', 'src/c.ts', 'a.ts');
      process.chdir(repo);

      const first = await listFiles();
      const second = await listFiles();

      expect(first.listedFiles).toEqual([
        '.gitmodules',
        'Z.ts',
        'a.ts',
        'b.ts',
        'lib/m.ts',
        'src/c.ts',
        'é.ts',
      ]);
      expect(second.listedFiles).toEqual(first.listedFiles);
    });

    describe('submodules', () => {
      it('lists nested submodules by the same rules, prefixed with their path', async () => {
        const inner = initSubmoduleSource('inner', 'inner.ts');
        const middle = initSubmoduleSource('middle', 'middle.ts');
        gitAllowingFileSubmodules(
          middle,
          'submodule',
          'add',
          '-q',
          inner,
          'deep',
        );
        commitAll(middle);
        const repo = initRepo('repo');
        touch(repo, 'src/a.ts');
        gitAllowingFileSubmodules(
          repo,
          'submodule',
          'add',
          '-q',
          middle,
          'lib',
        );
        commitAll(repo);
        gitAllowingFileSubmodules(
          repo,
          'submodule',
          'update',
          '-q',
          '--init',
          '--recursive',
        );
        write(path.join(repo, 'lib', '.gitignore'), '*.log\n');
        touch(repo, 'lib/untracked.ts', 'lib/debug.log');
        process.chdir(repo);

        const listing = await listFiles();

        expect(listing.listedFiles).toEqual([
          '.gitmodules',
          'lib/.gitignore',
          'lib/.gitmodules',
          'lib/deep/inner.ts',
          'lib/middle.ts',
          'lib/untracked.ts',
          'src/a.ts',
        ]);
      });

      it('lists nothing for an uninitialised submodule', async () => {
        const lib = initSubmoduleSource('lib', 'lib.ts');
        const origin = initRepo('origin');
        touch(origin, 'src/a.ts');
        gitAllowingFileSubmodules(origin, 'submodule', 'add', '-q', lib, 'lib');
        commitAll(origin);
        // A plain clone leaves the submodule uninitialised: an empty folder.
        git(tempRoot(), 'clone', '-q', origin, 'repo');
        process.chdir(path.join(tempRoot(), 'repo'));

        const listing = await listFiles();

        expect(listing.listedFiles).toEqual(['.gitmodules', 'src/a.ts']);
        expect(listing.fallbackReason).toBeNull();
      });

      it("returns a submodule's own tracked files that match its ignore rules separately", async () => {
        const lib = initSubmoduleSource('lib', 'lib.ts', 'dist/bundle.js');
        write(path.join(lib, '.gitignore'), 'dist/\n');
        commitAll(lib);
        const repo = initRepo('repo');
        gitAllowingFileSubmodules(repo, 'submodule', 'add', '-q', lib, 'lib');
        commitAll(repo);
        process.chdir(repo);

        const listing = await listFiles();

        expect(listing.listedFiles).toEqual([
          '.gitmodules',
          'lib/.gitignore',
          'lib/lib.ts',
        ]);
        expect(listing.trackedButIgnored).toEqual(['lib/dist/bundle.js']);
      });

      it('never lists a submodule outside the project folder', async () => {
        const inside = initSubmoduleSource('inside', 'inside.ts');
        const outside = initSubmoduleSource('outside', 'outside.ts');
        const repo = initRepo('repo');
        touch(repo, 'app/src/a.ts');
        gitAllowingFileSubmodules(
          repo,
          'submodule',
          'add',
          '-q',
          inside,
          'app/lib',
        );
        gitAllowingFileSubmodules(
          repo,
          'submodule',
          'add',
          '-q',
          outside,
          'vendor/outside',
        );
        commitAll(repo);
        process.chdir(path.join(repo, 'app'));

        const listing = await listFiles();

        expect(listing.listedFiles).toEqual(['lib/inside.ts', 'src/a.ts']);
      });

      // git shows a repo inside the project folder that isn't a submodule as
      // one untracked folder, `nested/`, and lists nothing inside it.
      it('lists nothing for a nested repo that is not a submodule', async () => {
        const repo = initRepo('repo');
        touch(repo, 'src/a.ts');
        initRepo(path.join('repo', 'nested'));
        touch(repo, 'nested/n.ts');
        process.chdir(repo);

        const listing = await listFiles();

        expect(listing.listedFiles).toEqual(['src/a.ts']);
      });
    });
  });

  // When git can't list, today's walker lists instead, unchanged: it applies
  // only .gitignore files from the project folder down, and its `.git` prefix
  // filter drops .github/ and .gitignore too.
  describe('falling back to the walker', () => {
    const touchWalkerFixture = (dir: string): void => {
      write(path.join(dir, '.gitignore'), 'ignored/\n');
      touch(dir, 'src/a.ts', 'ignored/b.ts', '.github/workflows/ci.yml');
    };

    it('lists with the walker outside a git repo, and says why', async () => {
      const project = path.join(tempRoot(), 'project');
      touchWalkerFixture(project);
      process.chdir(project);

      const listing = await listFiles();

      expect(listing).toEqual({
        listedFiles: ['src/a.ts'],
        trackedButIgnored: [],
        fallbackReason:
          'not a git repository (or any of the parent directories): .git',
        fallbackDetails:
          'fatal: not a git repository (or any of the parent directories): .git',
      });
    });

    it('lists with the walker when git is not installed, and says why', async () => {
      const repo = initRepo('repo');
      touchWalkerFixture(repo);
      // An empty PATH gives a real ENOENT when git is spawned.
      const emptyBin = path.join(tempRoot(), 'empty-bin');
      fs.mkdirSync(emptyBin);
      process.env.PATH = emptyBin;
      process.chdir(repo);

      const listing = await listFiles();

      expect(listing).toEqual({
        listedFiles: ['src/a.ts'],
        trackedButIgnored: [],
        fallbackReason: 'git was not found',
        fallbackDetails: null,
      });
    });

    it('lists with the walker when the project folder is itself ignored by git, and says why', async () => {
      const repo = initRepo('repo');
      write(path.join(repo, '.gitignore'), 'app/\n');
      touchWalkerFixture(path.join(repo, 'app'));
      process.chdir(path.join(repo, 'app'));

      const listing = await listFiles();

      expect(listing).toEqual({
        listedFiles: ['src/a.ts'],
        trackedButIgnored: [],
        fallbackReason: 'the project folder is ignored by git',
        fallbackDetails: null,
      });
    });

    // check-ignore skips paths in the index, so a force-added file mustn't
    // make the ignored folder look tracked, which would list nothing untracked.
    it('lists with the walker when the project folder is ignored by git but has force-added files', async () => {
      const repo = initRepo('repo');
      write(path.join(repo, '.gitignore'), 'app/\n');
      touchWalkerFixture(path.join(repo, 'app'));
      git(repo, 'add', '-f', 'app/src/a.ts');
      commitAll(repo);
      touch(repo, 'app/src/b.ts');
      process.chdir(path.join(repo, 'app'));

      const listing = await listFiles();

      expect(listing).toEqual({
        listedFiles: ['src/a.ts', 'src/b.ts'],
        trackedButIgnored: [],
        fallbackReason: 'the project folder is ignored by git',
        fallbackDetails: null,
      });
    });
  });
});

describe('splitRepoEntries', () => {
  const sorted = ({ files, nestedRepos, trackedButIgnored }) => ({
    files: [...files].sort(),
    nestedRepos: [...nestedRepos].sort(),
    trackedButIgnored: [...trackedButIgnored].sort(),
  });

  it('splits tracked and untracked files from gitlinks and nested repos', () => {
    expect(
      sorted(
        splitRepoEntries(
          [
            '100644 a1 0\tsrc/a.ts',
            '160000 b2 0\tlibs/core',
            '100755 e5 0\tbin/run',
          ],
          ['src/new.ts', 'tools/lib/'],
          [],
        ),
      ),
    ).toEqual({
      files: ['bin/run', 'src/a.ts', 'src/new.ts'],
      nestedRepos: ['libs/core', 'tools/lib'],
      trackedButIgnored: [],
    });
  });

  it('leaves out ignored files and does not list ignored gitlinks at all', () => {
    expect(
      sorted(
        splitRepoEntries(
          [
            '100644 a1 0\tsrc/a.ts',
            '160000 b2 0\tlibs/core',
            '100644 c3 0\tdist/out.js',
            '160000 d4 0\tvendor/sub',
          ],
          ['src/new.ts', 'tools/lib/'],
          ['dist/out.js', 'vendor/sub'],
        ),
      ),
    ).toEqual({
      files: ['src/a.ts', 'src/new.ts'],
      nestedRepos: ['libs/core', 'tools/lib'],
      trackedButIgnored: ['dist/out.js', 'vendor/sub'],
    });
  });

  it('lists a path in a merge conflict once', () => {
    expect(
      sorted(
        splitRepoEntries(
          [
            '100644 a1 1\tsrc/conflict.ts',
            '100644 a2 2\tsrc/conflict.ts',
            '100644 a3 3\tsrc/conflict.ts',
            '100644 c1 1\tdist/out.js',
            '100644 c2 2\tdist/out.js',
          ],
          [],
          ['dist/out.js', 'dist/out.js'],
        ),
      ),
    ).toEqual({
      files: ['src/conflict.ts'],
      nestedRepos: [],
      trackedButIgnored: ['dist/out.js'],
    });
  });

  it('keeps tabs, spaces and non-ASCII characters in paths', () => {
    expect(
      sorted(
        splitRepoEntries(
          ['100644 a1 0\tsrc/tab\there.ts', '160000 b2 0\tlibs/my lib'],
          ['src/café.ts', 'tools/ünï/'],
          [],
        ),
      ),
    ).toEqual({
      files: ['src/café.ts', 'src/tab\there.ts'],
      nestedRepos: ['libs/my lib', 'tools/ünï'],
      trackedButIgnored: [],
    });
  });

  it('returns empty lists for an empty repo', () => {
    expect(splitRepoEntries([], [], [])).toEqual({
      files: [],
      nestedRepos: [],
      trackedButIgnored: [],
    });
  });
});
