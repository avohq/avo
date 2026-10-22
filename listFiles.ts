import { spawn } from 'child_process';
import path from 'path';
import walk from 'ignore-walk';

export type FileListing = {
  // Listed files, relative to the project folder, in listing order
  files: string[];
  // Tracked files that match an ignore rule; kept out of `files`
  trackedIgnored: string[];
  // Set when git could not list the files and the walker was used instead
  fallbackReason?: string;
};

class GitError extends Error {
  reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

type GitResult = { code: number; stdout: string; stderr: string };

// Output is collected from the stream rather than buffered by execFile, whose
// default 1 MB maxBuffer is far smaller than a large repo's listing.
// The env is passed explicitly so that git sees this process's current env;
// under jest, process.env is a sandboxed copy the child would not inherit.
function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new GitError(
          error.code === 'ENOENT' ? 'git is not installed' : error.message,
        ),
      );
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function exitReason({ code, stderr }: GitResult): string {
  const detail = stderr.trim().split('\n')[0];
  return detail
    ? `git exited with code ${code}: ${detail}`
    : `git exited with code ${code}`;
}

// Runs git and rejects with a GitError on any non-zero exit.
function git(args: string[], cwd: string): Promise<string> {
  return runGit(args, cwd).then((result) => {
    if (result.code !== 0) {
      throw new GitError(exitReason(result));
    }
    return result.stdout;
  });
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

// Lists one repo (the main one or a submodule) from `cwd`. Paths come back
// relative to `cwd`. Gitlinks (submodule entries) are dropped: a submodule's
// files are listed separately, and an uninitialised one lists nothing.
function listRepo(
  cwd: string,
): Promise<{ files: string[]; trackedIgnored: string[] }> {
  return Promise.all([
    git(['ls-files', '-z', '--stage'], cwd),
    git(['ls-files', '-z', '--others', '--exclude-standard'], cwd),
    git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], cwd),
  ]).then(([staged, others, ignored]) => {
    // A path in a merge conflict has one entry per stage, so de-duplicate.
    // `--deduplicate` would need git 2.31.
    const files = new Set<string>();
    splitNul(staged).forEach((entry) => {
      // Each entry is `<mode> <object> <stage>\t<path>`
      const tab = entry.indexOf('\t');
      if (!entry.startsWith('160000 ')) {
        files.add(entry.substring(tab + 1));
      }
    });
    splitNul(others).forEach((file) => files.add(file));

    const trackedIgnored = Array.from(new Set(splitNul(ignored)));
    trackedIgnored.forEach((file) => files.delete(file));

    return { files: Array.from(files), trackedIgnored };
  });
}

// Initialised submodules below the project folder, nested ones included, as
// paths relative to it.
function listSubmodules(cwd: string): Promise<string[]> {
  return git(
    ['submodule', 'foreach', '--recursive', '--quiet', 'echo $displaypath'],
    cwd,
  ).then((output) =>
    output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('..')),
  );
}

// Byte-wise, like git's own ordering, so the listing order does not depend on
// the locale.
function compareListingOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function listWithGit(cwd: string): Promise<FileListing> {
  return runGit(['check-ignore', '-q', '.'], cwd)
    .then((result) => {
      if (result.code === 0) {
        throw new GitError('the project folder is ignored by git');
      }
      // check-ignore exits 1 when the path is not ignored, and 128 on errors
      // such as not being inside a repo
      if (result.code !== 1) {
        throw new GitError(exitReason(result));
      }
      return Promise.all([listRepo(cwd), listSubmodules(cwd)]);
    })
    .then(([main, submodules]) =>
      Promise.all(
        submodules.map((submodule) =>
          listRepo(path.join(cwd, submodule)).then((listing) => ({
            files: listing.files.map((file) => `${submodule}/${file}`),
            trackedIgnored: listing.trackedIgnored.map(
              (file) => `${submodule}/${file}`,
            ),
          })),
        ),
      ).then((listings) => {
        const all = [main, ...listings];
        return {
          files: all
            .flatMap((listing) => listing.files)
            .map(toPosix)
            .sort(compareListingOrder),
          trackedIgnored: all
            .flatMap((listing) => listing.trackedIgnored)
            .map(toPosix)
            .sort(compareListingOrder),
        };
      }),
    );
}

function listWithWalker(): Promise<string[]> {
  return walk({
    ignoreFiles: ['.gitignore'],
    follow: false,
  }).then((results) => results.filter((result) => !result.startsWith('.git')));
}

// Lists the files of the project folder (the cwd). Git lists them when it can,
// so the listed files are exactly what git would show: tracked files and
// untracked files that aren't ignored, minus tracked files that match an
// ignore rule. When git can't list, today's walker is used and the reason is
// returned.
export function listFiles(): Promise<FileListing> {
  const cwd = process.cwd();
  return listWithGit(cwd).catch((error) => {
    if (!(error instanceof GitError)) {
      throw error;
    }
    return listWithWalker().then((files) => ({
      files,
      trackedIgnored: [],
      fallbackReason: error.reason,
    }));
  });
}
