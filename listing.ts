import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import walk from 'ignore-walk';

// `path` is relative to the project folder; `reason` is why git failed.
export type UnlistedRepo = { path: string; reason: string };

export type Listing = {
  // Paths relative to the project folder, in listing order.
  listedFiles: string[];
  // Tracked files that match an ignore rule. Never part of listedFiles.
  trackedButIgnored: string[];
  // Nested repos git failed to list, so none of their files are listed.
  unlistedRepos: UnlistedRepo[];
  // Why git couldn't list and the walker did instead; null when git listed.
  fallbackReason: string | null;
  // git's whole error output behind fallbackReason, which can say more, such
  // as how to trust a folder with dubious ownership; null when git didn't run
  // or didn't fail.
  fallbackDetails: string | null;
};

// Thrown when git can't list the project folder; its message is the reason
// carried by the walker's listing.
class GitFallback extends Error {
  constructor(
    message: string,
    readonly details: string | null = null,
  ) {
    super(message);
  }
}

type GitResult = { code: number; stdout: Buffer; stderr: string };

// Runs git in `cwd`. The output is streamed rather than buffered by execFile,
// whose 1 MB maxBuffer a large repo's listing overflows. `env: process.env` is
// passed explicitly so a changed environment (as under jest) reaches git.
function runGit(args: string[], cwd = '.'): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new GitFallback(
          error.code === 'ENOENT'
            ? 'git was not found'
            : `git could not be run: ${error.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

// git's first line of stderr says why it failed, e.g. "fatal: not a git
// repository (or any of the parent directories): .git". The reason leaves out
// "fatal: ", which reads oddly after "because".
function gitFailure({ code, stderr }: GitResult): GitFallback {
  const firstLine = stderr.split('\n').find((line) => line.trim() !== '');
  const details = stderr.trim();
  return new GitFallback(
    firstLine?.trim().replace(/^fatal: /, '') ?? `git exited with code ${code}`,
    details === '' ? null : details,
  );
}

// Listings use `-z` and split on NUL: without `-z`, git quotes non-ASCII paths.
function gitLines(args: string[], cwd: string): Promise<string[]> {
  return runGit(args, cwd).then((result) => {
    if (result.code !== 0) {
      throw gitFailure(result);
    }
    return result.stdout
      .toString('utf8')
      .split('\0')
      .filter((line) => line !== '');
  });
}

function isProjectFolderIgnored(): Promise<boolean> {
  // --no-index: check-ignore otherwise skips paths in the index, so a file
  // force-added inside an ignored project folder would hide the ignore rule.
  return runGit(['check-ignore', '--no-index', '-q', '.']).then((result) => {
    // check-ignore exits 0 when the path is ignored and 1 when it isn't.
    if (result.code === 0 || result.code === 1) {
      return result.code === 0;
    }
    throw gitFailure(result);
  });
}

export type RepoEntries = {
  files: string[];
  nestedRepos: string[];
  trackedButIgnored: string[];
};

// Sorts one repo's `ls-files -z` entries into its files and the nested repos
// to list on their own. `staged` entries are "<mode> <object> <stage>\t<path>"
// (mode 160000 is a gitlink; a path in a merge conflict comes once per stage),
// a nested repo that isn't a submodule comes in `untracked` as `dir/`, and
// `ignored` holds the tracked paths that match an ignore rule. An ignored
// gitlink isn't listed at all, as git shows none of its files.
export function splitRepoEntries(
  staged: string[],
  untracked: string[],
  ignored: string[],
): RepoEntries {
  const ignoredPaths = new Set(ignored);
  const files = new Set<string>();
  const nestedRepos = new Set<string>();
  staged.forEach((entry) => {
    const entryPath = entry.slice(entry.indexOf('\t') + 1);
    if (ignoredPaths.has(entryPath)) {
      return;
    }
    (entry.startsWith('160000 ') ? nestedRepos : files).add(entryPath);
  });
  untracked.forEach((filePath) => {
    if (filePath.endsWith('/')) {
      nestedRepos.add(filePath.slice(0, -1));
    } else {
      files.add(filePath);
    }
  });
  return {
    files: [...files],
    nestedRepos: [...nestedRepos],
    trackedButIgnored: [...ignoredPaths],
  };
}

// One repo's share of the listing, its paths prefixed with the repo's path.
type RepoListing = Pick<
  Listing,
  'listedFiles' | 'trackedButIgnored' | 'unlistedRepos'
>;

// Lists one repo, the project folder's or a nested one, followed by every
// nested repo inside it, by the same rules. ls-files run in a subfolder only
// shows paths below it, so a nested repo outside the project folder is never
// listed. Nested repos are listed one at a time, so a repo with many doesn't
// spawn git for all of them at once.
function listRepo(cwd: string, prefix: string): Promise<RepoListing[]> {
  const withPrefix = (filePath: string): string => `${prefix}${filePath}`;

  // A nested repo without a `.git` is an uninitialised submodule: an empty
  // folder, with nothing to list. One git fails on, such as a submodule whose
  // gitdir is gone, is left out and said why, rather than sending the whole
  // listing to the walker.
  const listNestedRepo = (nestedRepo: string): Promise<RepoListing[]> => {
    const dir = path.join(cwd, nestedRepo);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      return Promise.resolve([]);
    }
    return listRepo(dir, `${withPrefix(nestedRepo)}/`).catch((error) => {
      if (error instanceof GitFallback) {
        return [
          {
            listedFiles: [],
            trackedButIgnored: [],
            unlistedRepos: [
              { path: withPrefix(nestedRepo), reason: error.message },
            ],
          },
        ];
      }
      throw error;
    });
  };

  return Promise.all([
    gitLines(['ls-files', '-z', '--stage'], cwd),
    gitLines(['ls-files', '-z', '--others', '--exclude-standard'], cwd),
    gitLines(
      ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'],
      cwd,
    ),
  ]).then(([staged, untracked, ignored]) => {
    const entries = splitRepoEntries(staged, untracked, ignored);
    return entries.nestedRepos.reduce(
      (listings, nestedRepo) =>
        listings.then((done) =>
          listNestedRepo(nestedRepo).then((nested) => [...done, ...nested]),
        ),
      Promise.resolve<RepoListing[]>([
        {
          listedFiles: entries.files.map(withPrefix),
          trackedButIgnored: entries.trackedButIgnored.map(withPrefix),
          unlistedRepos: [],
        },
      ]),
    );
  });
}

function listWithGit(): Promise<Listing> {
  return listRepo('.', '').then((listings) => ({
    // Listing order sorts by UTF-16 code unit, which unlike localeCompare is
    // the same on every machine, and doesn't depend on which repo a file is
    // in or whether it is committed yet.
    listedFiles: listings.flatMap((listing) => listing.listedFiles).sort(),
    trackedButIgnored: listings
      .flatMap((listing) => listing.trackedButIgnored)
      .sort(),
    unlistedRepos: listings.flatMap((listing) => listing.unlistedRepos),
    fallbackReason: null,
    fallbackDetails: null,
  }));
}

// The walker status used before git listing, unchanged, including its `.git`
// prefix filter.
function listWithWalker(fallback: GitFallback): Promise<Listing> {
  return walk({
    ignoreFiles: ['.gitignore'],
    follow: false,
  }).then((results) => ({
    listedFiles: results.filter((result) => !result.startsWith('.git')),
    trackedButIgnored: [],
    unlistedRepos: [],
    fallbackReason: fallback.message,
    fallbackDetails: fallback.details,
  }));
}

// Lists the files under the project folder (the cwd) with git, falling back
// to the walker when git is missing, git fails, or git ignores the project
// folder itself.
export function listFiles(): Promise<Listing> {
  return isProjectFolderIgnored()
    .then((ignored) => {
      if (ignored) {
        throw new GitFallback('the project folder is ignored by git');
      }
      return listWithGit();
    })
    .catch((error) => {
      if (error instanceof GitFallback) {
        return listWithWalker(error);
      }
      throw error;
    });
}
