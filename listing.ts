import { spawn } from 'child_process';
import walk from 'ignore-walk';

export type Listing = {
  // Paths relative to the project folder, in listing order.
  listedFiles: string[];
  // Tracked files that match an ignore rule. Never part of listedFiles.
  trackedButIgnored: string[];
  // Why git couldn't list and the walker did instead; null when git listed.
  fallbackReason: string | null;
};

// Thrown when git can't list the project folder; its message is the reason
// carried by the walker's listing.
class GitFallback extends Error {}

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
// repository (or any of the parent directories): .git".
function gitFailure({ code, stderr }: GitResult): GitFallback {
  const firstLine = stderr.split('\n').find((line) => line.trim() !== '');
  return new GitFallback(firstLine?.trim() ?? `git exited with code ${code}`);
}

// Listings use `-z` and split on NUL: without `-z`, git quotes non-ASCII paths.
function gitLines(
  args: string[],
  cwd: string,
  separator: string,
): Promise<string[]> {
  return runGit(args, cwd).then((result) => {
    if (result.code !== 0) {
      throw gitFailure(result);
    }
    return result.stdout
      .toString('utf8')
      .split(separator)
      .filter((line) => line !== '');
  });
}

function isProjectFolderIgnored(): Promise<boolean> {
  return runGit(['check-ignore', '-q', '.']).then((result) => {
    // check-ignore exits 0 when the path is ignored and 1 when it isn't.
    if (result.code === 0 || result.code === 1) {
      return result.code === 0;
    }
    throw gitFailure(result);
  });
}

type RepoListing = {
  paths: string[];
  trackedButIgnored: string[];
  hasSubmodules: boolean;
};

// Lists one repo, the project folder's or a submodule. --stage gives each
// tracked file's mode, so submodule entries can be dropped. Tracked files that
// match an ignore rule come back separately, for the caller to remove.
function listRepo(cwd: string, prefix: string): Promise<RepoListing> {
  const withPrefix = (filePath: string): string => `${prefix}${filePath}`;
  return Promise.all([
    gitLines(['ls-files', '-z', '--stage'], cwd, '\0'),
    gitLines(['ls-files', '-z', '--others', '--exclude-standard'], cwd, '\0'),
    gitLines(
      ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'],
      cwd,
      '\0',
    ),
  ]).then(([stagedEntries, untracked, trackedButIgnored]) => {
    // Each entry is "<mode> <object> <stage>\t<path>". Mode 160000 is a
    // submodule, listed as its own repo, or not at all when uninitialised.
    const isSubmodule = (entry: string): boolean => entry.startsWith('160000 ');
    const tracked = stagedEntries
      .filter((entry) => !isSubmodule(entry))
      .map((entry) => entry.slice(entry.indexOf('\t') + 1));
    // A nested repo that isn't a submodule is listed as its folder, `nested/`.
    const untrackedFiles = untracked.filter(
      (filePath) => !filePath.endsWith('/'),
    );
    return {
      paths: [...tracked, ...untrackedFiles].map(withPrefix),
      trackedButIgnored: trackedButIgnored.map(withPrefix),
      hasSubmodules: stagedEntries.some(isSubmodule),
    };
  });
}

// Paths of the initialised submodules, nested ones included, relative to the
// project folder. Submodules elsewhere in the repo come back as `../` paths
// and are dropped: avo status never looks above the project folder.
// --recurse-submodules isn't used because with --ignored it only checks the
// main repo, missing a submodule's tracked-but-ignored files.
function listSubmodules(): Promise<string[]> {
  return gitLines(
    [
      'submodule',
      'foreach',
      '--recursive',
      '--quiet',
      'printf "%s\\n" "$displaypath"',
    ],
    '.',
    '\n',
  ).then((submodules) =>
    submodules.filter((submodule) => !submodule.startsWith('../')),
  );
}

function listWithGit(): Promise<Listing> {
  return listRepo('.', '')
    .then((projectFolder) =>
      // `git submodule` is slow to start, so it only runs when the project
      // folder holds a submodule.
      (projectFolder.hasSubmodules
        ? listSubmodules()
        : Promise.resolve<string[]>([])
      ).then((submodules) =>
        // One submodule at a time, so a repo with many doesn't spawn git for
        // all of them at once.
        submodules.reduce(
          (listings, submodule) =>
            listings.then((done) =>
              listRepo(submodule, `${submodule}/`).then((listing) => [
                ...done,
                listing,
              ]),
            ),
          Promise.resolve([projectFolder]),
        ),
      ),
    )
    .then((listings) => {
      // A path in a merge conflict is listed once per stage. git's own
      // --deduplicate needs git 2.31, so de-duplicate here.
      const paths = new Set(listings.flatMap((listing) => listing.paths));
      const ignored = new Set(
        listings.flatMap((listing) => listing.trackedButIgnored),
      );
      // Listing order sorts by UTF-16 code unit, which unlike localeCompare is
      // the same on every machine, and doesn't depend on which repo a file is
      // in or whether it is committed yet.
      return {
        listedFiles: [...paths]
          .filter((filePath) => !ignored.has(filePath))
          .sort(),
        trackedButIgnored: [...ignored].sort(),
        fallbackReason: null,
      };
    });
}

// The walker status used before git listing, unchanged, including its `.git`
// prefix filter.
function listWithWalker(fallbackReason: string): Promise<Listing> {
  return walk({
    ignoreFiles: ['.gitignore'],
    follow: false,
  }).then((results) => ({
    listedFiles: results.filter((result) => !result.startsWith('.git')),
    trackedButIgnored: [],
    fallbackReason,
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
        return listWithWalker(error.message);
      }
      throw error;
    });
}
