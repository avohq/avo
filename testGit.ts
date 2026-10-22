// Test-only helpers for suites that run real git. Not compiled or shipped.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach } from '@jest/globals';

// Isolates git from the developer's machine: a temp HOME at `<tempRoot>/home`
// (so ~/.gitconfig and the global ignore file are the test's own), no system
// config, a fixed commit identity, and a ceiling so git never finds a repo
// above `tempRoot`. jest hands tests a copy of process.env, so git only sees
// these because every spawn (in tests and in listing.ts) passes
// `env: process.env` explicitly. Returns a function that puts the whole
// environment back as it was, undoing whatever the test changed since, such as
// PATH.
const isolateGit = (tempRoot: string): (() => void) => {
  const previousEnv = { ...process.env };

  Object.keys(process.env)
    .filter((key) => key.startsWith('GIT_'))
    .forEach((key) => {
      delete process.env[key];
    });
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = path.join(tempRoot, 'home');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CEILING_DIRECTORIES = tempRoot;
  process.env.GIT_AUTHOR_NAME = 'Avo Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@avo.app';
  process.env.GIT_COMMITTER_NAME = 'Avo Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@avo.app';
  // Keeps git's error messages in English, so the fallback reasons can be pinned.
  process.env.LC_ALL = 'C';
  fs.mkdirSync(process.env.HOME);

  return () => {
    Object.keys(process.env).forEach((key) => {
      delete process.env[key];
    });
    Object.assign(process.env, previousEnv);
  };
};

// Gives every test in the calling block a new temp folder, named from
// `prefix`, with git isolated to it (see isolateGit). Afterwards it puts back
// the cwd and the environment and deletes the folder. Returns a function that
// gives the current test's temp folder, as a real path, the way process.cwd()
// reports it after a chdir.
export const useIsolatedGit = (prefix: string): (() => string) => {
  let tempRoot: string;
  let previousCwd: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    restoreEnv = isolateGit(tempRoot);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    restoreEnv();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  return () => tempRoot;
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
  });

export const commitAll = (dir: string): void => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'commit');
};
