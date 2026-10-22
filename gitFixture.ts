// Test helpers for the git-backed suites. Fixtures are real repos in temp
// folders, and git is isolated from the developer's machine: HOME points at a
// temp folder (GIT_CONFIG_GLOBAL would need git 2.32), the system config is
// skipped, the commit identity comes from the environment, and repo discovery
// stops at the temp root.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach } from '@jest/globals';

const GIT_ENV_KEYS = [
  'HOME',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CEILING_DIRECTORIES',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_COUNT',
];

export type GitSandbox = {
  // The temp root; every fixture lives below it
  root: () => string;
};

// Creates a fresh temp root per test with git isolated to it, and restores the
// environment and cwd afterwards.
export function useGitSandbox(): GitSandbox {
  let root: string;
  let previousCwd: string;
  let previousEnv: { [key: string]: string | undefined };

  beforeEach(() => {
    previousCwd = process.cwd();
    previousEnv = Object.fromEntries(
      GIT_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    // realpath, because the temp folder is behind a symlink on macOS
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'avo-git-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      [
        '[init]',
        '\tdefaultBranch = main',
        '[protocol "file"]',
        '\tallow = always',
        '',
      ].join('\n'),
    );
    Object.assign(process.env, {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: root,
      GIT_AUTHOR_NAME: 'Avo Test',
      GIT_AUTHOR_EMAIL: 'test@avo.app',
      GIT_COMMITTER_NAME: 'Avo Test',
      GIT_COMMITTER_EMAIL: 'test@avo.app',
      // drops config injected through GIT_CONFIG_KEY_<n> variables
      GIT_CONFIG_COUNT: '0',
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root: () => root };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    // under jest, process.env is a sandboxed copy children would not inherit
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Like `git`, but for commands expected to fail, such as a conflicting merge
export function gitAllowingFailure(cwd: string, ...args: string[]): void {
  try {
    git(cwd, ...args);
  } catch {
    // expected
  }
}

export function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  return dir;
}

export function commitAll(dir: string, message = 'commit'): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}

// Writes each file (creating folders), relative to `dir`
export function writeFiles(
  dir: string,
  files: { [file: string]: string | Buffer },
): void {
  Object.entries(files).forEach(([file, content]) => {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  });
}
