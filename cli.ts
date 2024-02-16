#!/usr/bin/env node
import ora from 'ora';
import chalk from 'chalk';
import { Minimatch } from 'minimatch';
import dateFns from 'date-fns';
import fs from 'fs';
import http from 'http';
import inquirer from 'inquirer';
import jwt from 'jsonwebtoken';
import { loadJsonFile } from 'load-json-file';
import logSymbols from 'log-symbols';
import open from 'open';
import path from 'path';
import pify from 'pify';
import portfinder from 'portfinder';
import querystring from 'querystring';
import got from 'got'; // eslint-disable-line import/no-unresolved
import report from 'yurnalist';
import semver from 'semver';
import updateNotifier from 'update-notifier';
import url from 'url';
import util from 'util';
import { v4 as uuidv4 } from 'uuid';
import walk from 'ignore-walk';
import writeFile from 'write';
import { writeJsonFile } from 'write-json-file';
import Configstore from 'configstore';
import { AvoInspector, AvoInspectorEnv } from 'node-avo-inspector';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import httpShutdown from 'http-shutdown';
import fuzzypath from 'inquirer-fuzzy-path';

import Avo from './Avo.js';

declare global {
  namespace NodeJS {
    interface ImportMeta {
      url: string;
    }
  }
}

const pkg = JSON.parse(
  fs.readFileSync(new URL('package.json', import.meta.url), 'utf-8'),
);

/// //////////////////////////////////////////////////////////////////////
// LOGGING
const { cyan, gray, red, bold, underline } = chalk;

function cmd(command) {
  return `${gray('`')}${cyan(command)}${gray('`')}`;
}

function link(text) {
  return underline(text);
}

function file(text) {
  return underline(text);
}

function email(text) {
  return underline(text);
}

// to cancel spinners globally
let _cancel = null;

let cancelWait = () => {
  if (_cancel !== null) {
    _cancel();
    _cancel = null;
  }
};

function wait(message, timeOut = 300) {
  cancelWait();
  let running = false;
  let spinner;
  let stopped = false;

  setTimeout(() => {
    if (stopped) return;

    spinner = ora(gray(message));
    spinner.color = 'gray';
    spinner.start();

    running = true;
  }, timeOut);

  const cancel = () => {
    stopped = true;
    if (running) {
      spinner.stop();
      running = false;
    }
    process.removeListener('nowExit', cancel);
  };

  process.on('nowExit', cancel);
  cancelWait = cancel;
}

// register inquirer-file-path
inquirer.registerPrompt('fuzzypath', fuzzypath);

updateNotifier({ pkg }).notify();

const conf = new Configstore(pkg.name);

if (!conf.has('avo_install_id')) {
  conf.set('avo_install_id', uuidv4());
}

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

const nonce = (1 + Math.random() * (2 << 29)).toString();

function isString(str) {
  if (str != null && typeof str.valueOf() === 'string') {
    return true;
  }
  return false;
}

const sum = (base, value) => base + value;

portfinder.basePort = 9005;
const _getPort = portfinder.getPortPromise;

type ErrorOptions = {
  status?: number;
  exit?: number;
  original?: Error;
  context?: Object;
};

function AvoError(message, options: ErrorOptions = {}) {
  this.name = 'AvoError';
  this.message = message;
  this.status = options.status ?? 500;
  this.exit = options.exit ?? 1;
  this.stack = new Error().stack;
  this.original = options.original;
  this.context = options.context;
}
AvoError.prototype = Object.create(Error.prototype);

const INVALID_CREDENTIAL_ERROR = new AvoError(
  `Authentication Error: Your credentials are no longer valid. Please run ${cmd(
    'avo logout; avo login',
  )}`,
  { exit: 1 },
);

type ApiTokenResult = {
  idToken?: string;
  refreshToken?: string;
  expiresIn: number;
};

// in-memory cache, so we have it for successive calls
type LastAccessToken = {
  expiresAt?: number;
  refreshToken?: string;
  idToken?: string;
};

let lastAccessToken: LastAccessToken = {};
let accessToken;
let refreshToken;

/// //////////////////////////////////////////////////////////////////////
// REQUEST HANDLING

function responseToError(response, error) {
  if (!response) {
    return new AvoError(error, {});
  }

  let { body } = response;
  if (typeof body === 'string' && response.statusCode === 404) {
    body = {
      error: {
        message: 'Not Found',
      },
    };
  }

  if (response.statusCode < 400) {
    return null;
  }

  if (typeof body !== 'object') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }

  if (!body.error) {
    const getMessage = (statusCode) => {
      switch (statusCode) {
        case 401:
          return 'Unauthorized';
        case 403:
          return 'Forbidden. Do you have the required permissions? Some commands require editor or admin access.';
        case 404:
          return 'Not Found';
        default:
          return 'Unknown Error';
      }
    };
    body.error = {
      message: getMessage(response.statusCode),
    };
  }

  const message = `HTTP Error: ${response.statusCode}, ${
    body.error.message ?? body.error
  }`;

  let exitCode;
  if (response.statusCode >= 500) {
    // 5xx errors are unexpected
    exitCode = 2;
  } else {
    // 4xx errors happen sometimes
    exitCode = 1;
  }

  delete response.request.headers;

  return new AvoError(message, {
    context: {
      body,
      response,
    },
    exit: exitCode,
  });
}

function _request(options) {
  return new Promise((resolve, reject) => {
    got(options)
      .then((response) => {
        if (response.statusCode >= 400) {
          return reject(responseToError(response, null));
        }
        return resolve(JSON.parse(response.body));
      })
      .catch((err) => {
        report.error(`${responseToError(err.response, err)}\n`);
        reject(
          new AvoError(`Server Error. ${err.message}`, {
            original: err,
            exit: 2,
          }),
        );
      });
  });
}

const _appendQueryData = (urlPath, data) => {
  let returnPath = urlPath;
  if (data && Object.keys(data).length > 0) {
    returnPath += returnPath.includes('?') ? '&' : '?';
    returnPath += querystring.stringify(data);
  }
  return returnPath;
};

function _refreshAccessToken(refreshToken) {
  return api // eslint-disable-line
    .request('POST', '/auth/refresh', {
      origin: api.apiOrigin, // eslint-disable-line
      json: {
        token: refreshToken,
      },
    })
    .then(
      (data: ApiTokenResult) => {
        if (!isString(data.idToken)) {
          throw INVALID_CREDENTIAL_ERROR;
        }
        lastAccessToken = {
          expiresAt: Date.now() + data.expiresIn * 1000,
          refreshToken,
          ...data,
        };

        const currentRefreshToken = conf.get('tokens').refreshToken;
        if (refreshToken === currentRefreshToken) {
          conf.set('tokens', lastAccessToken);
        }

        return lastAccessToken;
      },
      () => {
        throw INVALID_CREDENTIAL_ERROR;
      },
    );
}

function _haveValidAccessToken(refreshToken) {
  if (Object.keys(lastAccessToken).length === 0) {
    const tokens = conf.get('tokens');
    if (refreshToken === tokens.refreshToken) {
      lastAccessToken = tokens;
    }
  }

  return (
    lastAccessToken.idToken &&
    lastAccessToken.refreshToken === refreshToken &&
    lastAccessToken.expiresAt &&
    lastAccessToken.expiresAt > Date.now() + FIFTEEN_MINUTES_IN_MS
  );
}

function getAccessToken(refreshToken) {
  if (_haveValidAccessToken(refreshToken)) {
    return Promise.resolve(lastAccessToken);
  }

  return _refreshAccessToken(refreshToken);
}

type ReqOptions = {
  method: string;
  decompress: boolean;
  headers: object; // Should be stricter
  json?: object;
  form?: object; // Is it?
  url?: string;
};

const api = {
  authOrigin: 'https://www.avo.app',

  apiOrigin: 'https://api.avo.app',

  setRefreshToken(token) {
    refreshToken = token;
  },
  setAccessToken(token) {
    accessToken = token;
  },
  getAccessToken() {
    return accessToken
      ? Promise.resolve({ idToken: accessToken })
      : getAccessToken(refreshToken);
  },
  addRequestHeaders(reqOptions) {
    // Runtime fetch of Auth singleton to prevent circular module dependencies
    return api.getAccessToken().then((result) => ({
      ...reqOptions,
      headers: {
        ...reqOptions.headers,
        'User-Agent': `AvoCLI/${pkg.version}`,
        'X-Client-Version': `AvoCLI/${pkg.version}`,
        authorization: `Bearer ${result.idToken}`,
      },
    }));
  },
  request(method, resource, options) {
    const validMethods = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'];

    const reqOptions: ReqOptions = {
      method: validMethods.includes(method) ? method : 'GET',
      decompress: true,
      headers: options.headers ?? {},
    };

    let urlPath = resource;
    if (options.query) {
      urlPath = _appendQueryData(urlPath, options.query);
    }

    if (reqOptions.method === 'GET') {
      urlPath = _appendQueryData(urlPath, options.json);
    } else if (Object.keys(options.json).length > 0) {
      reqOptions.json = options.json;
    } else if (Object.keys(options.form).length > 0) {
      reqOptions.form = options.form;
    }

    reqOptions.url = options.origin + urlPath;

    let requestFunction = () => _request(reqOptions);

    if (options.auth === true) {
      requestFunction = () =>
        api
          .addRequestHeaders(reqOptions)
          .then((reqOptionsWithToken) => _request(reqOptionsWithToken));
    }

    return requestFunction().catch((err) => {
      if (
        options.retryCodes &&
        options.retryCodes.includes(err.context.response.statusCode)
      ) {
        return new Promise((resolve) => {
          setTimeout(resolve, 1000);
        }).then(requestFunction);
      }
      return Promise.reject(err);
    });
  },
};

const customAnalyticsDestination = {
  make: function make(production) {
    this.production = production;
  },

  logEvent: (userId, eventName, eventProperties) => {
    api
      .request('POST', '/c/v1/track', {
        origin: api.apiOrigin,
        json: {
          userId,
          eventName,
          eventProperties,
        },
      })
      .catch(() => {
        // don't crash on tracking errors
      });

    return undefined;
  },

  setUserProperties: () => undefined, // noop
};

const inspector = new AvoInspector({
  apiKey: '3UWtteG9HenZ825cYoYr',
  env: AvoInspectorEnv.Prod,
  version: pkg.version,
  appName: 'Avo CLI',
});

// setup Avo analytics
Avo.initAvo(
  { env: Avo.AvoEnv.Prod, inspector },
  { client: Avo.Client.CLI, version: pkg.version },
  {},
  customAnalyticsDestination,
);

type Branch = {
  name: string;
  id: string;
};
type Schema = {
  id: string;
  name: string;
};
type Source = {
  id: string;
  name: string;
  path: string;
  actionId: string;
  branchId: string;
  updatedAt: string;
  interfacePath?: string;
  analysis?: {
    glob: string;
    module?: string;
  };
  filenameHint?: string;
  canHaveInterfaceFile?: boolean;
};

type AvoJson = {
  avo: {
    version: number;
  };
  schema: Schema;
  branch: Branch;
  force?: boolean;
  forceFeatures?: string;
  sources?: Source[];
};

function isLegacyAvoJson(json): boolean {
  // check if legacy avo.json or un-initialized project
  return json.types ?? !json.schema;
}

function avoNeedsUpdate(json: AvoJson): boolean {
  // if avo.json has version, and this binary has lower version number it needs updating
  return (
    json.avo && json.avo.version && semver.major(pkg.version) < json.avo.version
  );
}

const MERGE_CONFLICT_ANCESTOR = '|||||||';
const MERGE_CONFLICT_END = '>>>>>>>';
const MERGE_CONFLICT_SEP = '=======';
const MERGE_CONFLICT_START = '<<<<<<<';
function hasMergeConflicts(str: string): boolean {
  return (
    str.includes(MERGE_CONFLICT_START) &&
    str.includes(MERGE_CONFLICT_SEP) &&
    str.includes(MERGE_CONFLICT_END)
  );
}

function extractConflictingFiles(str: string): [string, string] {
  const files = [[], []];
  const lines = str.split(/\r?\n/g);
  let skip = false;

  while (lines.length) {
    const line = lines.shift();
    if (line.startsWith(MERGE_CONFLICT_START)) {
      while (lines.length) {
        const conflictLine = lines.shift();
        if (conflictLine === MERGE_CONFLICT_SEP) {
          skip = false;
          break;
        } else if (skip || conflictLine.startsWith(MERGE_CONFLICT_ANCESTOR)) {
          skip = true;
        } else {
          files[0].push(conflictLine);
        }
      }

      while (lines.length) {
        const conflictLine = lines.shift();
        if (conflictLine.startsWith(MERGE_CONFLICT_END)) {
          break;
        } else {
          files[1].push(conflictLine);
        }
      }
    } else {
      files[0].push(line);
      files[1].push(line);
    }
  }

  return [files[0].join('\n'), files[1].join('\n')];
}

enum BranchStatus {
  BRANCH_UP_TO_DATE = 'branch-up-to-date',
  BRANCH_NOT_UP_TO_DATE = 'branch-not-up-to-date',
}

function getMasterStatus(json: AvoJson): Promise<BranchStatus> {
  if (json.branch.id === 'master') {
    return Promise.resolve(BranchStatus.BRANCH_UP_TO_DATE);
  }
  return api
    .request('POST', '/c/v1/master', {
      origin: api.apiOrigin,
      auth: true,
      json: {
        schemaId: json.schema.id,
        branchId: json.branch.id,
      },
    })
    .then(({ pullRequired }) =>
      pullRequired
        ? BranchStatus.BRANCH_NOT_UP_TO_DATE
        : BranchStatus.BRANCH_UP_TO_DATE,
    );
}

function pullMaster(json: AvoJson): Promise<AvoJson> {
  if (json.branch.name === 'main') {
    report.info('Your current branch is main');
    return Promise.resolve(json);
  }
  wait(
    json.force ? 'Force pulling main into branch' : 'Pulling main into branch',
  );
  return api
    .request('POST', '/c/v1/master/pull', {
      origin: api.apiOrigin,
      auth: true,
      json: {
        schemaId: json.schema.id,
        branchId: json.branch.id,
        force: json.force,
      },
    })
    .then(() => {
      cancelWait();
      report.success('Branch is up to date with main');
      return json;
    });
}

function promptPullMaster(json: AvoJson): Promise<AvoJson> {
  wait('Check if branch is up to date with main');
  return getMasterStatus(json)
    .then((branchStatus) => {
      cancelWait();
      if (branchStatus === BranchStatus.BRANCH_NOT_UP_TO_DATE) {
        return inquirer
          .prompt([
            {
              type: 'confirm',
              name: 'pull',
              default: true,
              message: `Your branch '${bold(
                json.branch.name,
              )}' is not up to date with the Avo main branch. Would you like to pull main into your branch?`,
            },
          ])
          .then((answer) => Promise.resolve([branchStatus, answer]));
      }

      // We're expecting branchStatus === BRANCH_UP_TO_DATE
      return Promise.resolve([branchStatus]);
    })
    .then(([branchStatus, answer]) => {
      if (branchStatus === BranchStatus.BRANCH_UP_TO_DATE) {
        report.success('Branch is up to date with main');
        return Promise.resolve(json);
      }
      if (answer.pull) {
        return pullMaster(json);
      }
      report.info('Did not pull main into branch');
      return Promise.resolve(json);
    });
}

const installIdOrUserId = (): string =>
  conf.get('user')?.user_id ?? conf.get('avo_install_id');

const invokedByCi = (): boolean => process.env.CI !== undefined;

function requireAuth<T>(
  argv: { token?: string; user?: string; tokens?: any },
  cb: () => T,
): T {
  const tokens = conf.get('tokens');
  const user = conf.get('user');

  const tokenOpt = argv.token ?? process.env.AVO_TOKEN;

  if (tokenOpt) {
    api.setRefreshToken(tokenOpt);
    return cb();
  }

  if (!user || !tokens) {
    report.error(`Command requires authentication. Run ${cmd('avo login')}`);
    process.exit(1);
  }

  argv.user = user; // eslint-disable-line no-param-reassign
  argv.tokens = tokens; // eslint-disable-line no-param-reassign
  api.setRefreshToken(tokens.refreshToken);
  return cb();
}

type ApiWorkspacesResult = {
  workspaces: [{ lastUsedAt: number; name: string; id: string }];
};

function init(): Promise<AvoJson> {
  const makeAvoJson = (schema: {
    id: string;
    name: string;
  }): Promise<AvoJson> => {
    report.success(`Initialized for workspace ${cyan(schema.name)}`);

    return Promise.resolve({
      avo: {
        version: semver.major(pkg.version),
      },
      schema: {
        id: schema.id,
        name: schema.name,
      },
      branch: {
        id: 'master',
        name: 'main',
      },
    });
  };

  wait('Initializing');

  return api
    .request('GET', '/c/v1/workspaces', {
      origin: api.apiOrigin,
      auth: true,
    })
    .then(({ workspaces }: ApiWorkspacesResult) => {
      cancelWait();
      const schemas = [...workspaces].sort(
        (a, b) => a.lastUsedAt - b.lastUsedAt,
      );
      if (schemas.length > 1) {
        const choices = schemas.map((schema) => ({
          value: schema,
          name: schema.name,
        }));
        return inquirer
          .prompt([
            {
              type: 'list',
              name: 'schema',
              message: 'Select a workspace to initialize',
              choices,
            },
          ])
          .then((answer) => makeAvoJson(answer.schema));
      }
      if (schemas.length === 0) {
        throw new AvoError(
          `No workspaces to initialize. Go to ${link(
            'wwww.avo.app',
          )} to create one`,
        );
      } else {
        const schema = schemas[0];
        return makeAvoJson(schema);
      }
    });
}

function validateAvoJson(json: AvoJson): Promise<AvoJson> {
  if (avoNeedsUpdate(json)) {
    throw new AvoError('Your avo CLI is outdated, please update');
  }

  if (isLegacyAvoJson(json)) {
    return init();
  }

  // augment the latest major version into avo.json
  return Promise.resolve({
    ...json,
    avo: { ...json.avo, version: semver.major(pkg.version) },
  });
}

type ApiBranchesResult = {
  branches: [{ name: string; id: string }];
};

function fetchBranches(json: AvoJson): Promise<Branch[]> {
  wait('Fetching open branches');
  const payload = {
    origin: api.apiOrigin,
    auth: true,
    json: {
      schemaId: json.schema.id,
    },
  };
  return api
    .request('POST', '/c/v1/branches', payload)
    .then((data: ApiBranchesResult) => {
      cancelWait();
      const branches = [...data.branches].sort((a, b) => {
        if (a.name < b.name) return -1;
        if (a.name > b.name) return 1;
        return 0;
      });
      // The api still returns master for backwards comparability so we manually
      // update the branch name to main
      return branches.map((branch) =>
        branch.name === 'master' ? { ...branch, name: 'main' } : branch,
      );
    });
}

function checkout(branchToCheckout: string, json: AvoJson): Promise<AvoJson> {
  return fetchBranches(json).then((branches) => {
    if (!branchToCheckout) {
      const choices = branches.map((branch) => ({
        value: branch,
        name: branch.name,
      }));
      const currentBranch = branches.find(({ id }) => id === json.branch.id);
      return inquirer
        .prompt([
          {
            type: 'list',
            name: 'branch',
            message: 'Select a branch',
            default:
              currentBranch ?? branches.find(({ id }) => id === 'master'),
            choices,
            pageSize: 15,
          },
        ])
        .then((answer) => {
          if (answer.branch === currentBranch) {
            report.info(`Already on '${currentBranch.name}'`);
            return json;
          }
          const { branch } = answer;
          report.success(`Switched to branch '${branch.name}'`);
          return {
            ...json,
            branch: {
              id: branch.id,
              name: branch.name,
            },
          };
        });
    }
    if (branchToCheckout === 'master') {
      report.info(
        "The master branch has been renamed to main. Continuing checkout with main branch...'",
      );
    }
    const adjustedBranchToCheckout =
      branchToCheckout === 'master' ? 'main' : branchToCheckout;
    if (adjustedBranchToCheckout === json.branch.name) {
      // XXX should check here if json.branch.id === branch.id from server
      // if not, it indicates branch delete, same branch re-created and client is out of sync
      report.info(`Already on '${adjustedBranchToCheckout}'`);
      return json;
    }
    const branch = branches.find(
      ({ name }) => name === adjustedBranchToCheckout,
    );

    if (!branch) {
      report.error(
        `Branch '${adjustedBranchToCheckout}' does not exist. Run ${cmd(
          'avo checkout',
        )} to list available branches`,
      );
    }

    report.success(`Switched to branch '${branch.name}'`);
    return {
      ...json,
      branch: {
        id: branch.id,
        name: branch.name,
      },
    };
  });
}

function resolveAvoJsonConflicts(
  avoFile: string,
  { argv, skipPullMaster }: { argv: any; skipPullMaster: boolean },
): Promise<AvoJson> {
  report.info('Resolving Avo merge conflicts');
  const files = extractConflictingFiles(avoFile);
  const head = JSON.parse(files[0]);
  const incoming = JSON.parse(files[1]);

  Avo.cliConflictResolveAttempted({
    userId_: installIdOrUserId(),
    cliInvokedByCi: invokedByCi(),
    schemaId: head.schema.id,
    schemaName: head.schema.name,
    branchId: head.branch.id,
    branchName: head.branch.name,
  });

  if (
    head.avo.version !== incoming.avo.version ||
    head.schema.id !== incoming.schema.id
  ) {
    Avo.cliConflictResolveFailed({
      userId_: installIdOrUserId(),
      cliInvokedByCi: invokedByCi(),
      schemaId: head.schema.id,
      schemaName: head.schema.name,
      branchId: head.branch.id,
      branchName: head.branch.name,
    });
    throw new Error(
      "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in avo.json before running 'avo pull' again.",
    );
  }

  if (
    JSON.stringify(head.sources.map((s) => s.id)) !==
    JSON.stringify(incoming.sources.map((s) => s.id))
  ) {
    Avo.cliConflictResolveFailed({
      userId_: installIdOrUserId(),
      cliInvokedByCi: invokedByCi(),
      schemaId: head.schema.id,
      schemaName: head.schema.name,
      branchId: head.branch.id,
      branchName: head.branch.name,
    });
    throw new Error(
      "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in sources list in avo.json before running 'avo pull' again.",
    );
  }

  const nextAvoJson = {
    avo: head.avo,
    schema: head.schema,
    branch: head.branch,
    sources: head.sources,
  };

  return requireAuth(argv, () =>
    fetchBranches(nextAvoJson).then((branches) => {
      const isHeadBranchOpen = branches.find(
        (branch) => branch.id === nextAvoJson.branch.id,
      );

      const isIncomingBranchOpen = branches.find(
        (branch) => branch.id === incoming.branch.id,
      );

      function switchBranchIfRequired(json) {
        if (isHeadBranchOpen) {
          return Promise.resolve(json);
        }
        report.info(
          `Your current branch '${json.branch.name}' has been closed or merged. Go to another branch:`,
        );
        return checkout(null, json);
      }

      return switchBranchIfRequired(nextAvoJson)
        .then((json) => {
          if (
            head.branch.id === incoming.branch.id ||
            incoming.branch.id === 'master'
          ) {
            return Promise.resolve([true, json]);
          }
          return Promise.resolve([false, json]);
        })
        .then(([isDone, json]) => {
          if (!isDone && isIncomingBranchOpen && argv.force) {
            report.warn(
              `Incoming branch, ${
                incoming.branch.name
              }, has not been merged to Avo main. To review and merge go to: ${link(
                `https://www.avo.app/schemas/${nextAvoJson.schema.id}/branches/${incoming.branch.id}/diff`,
              )}`,
            );
            return Promise.resolve(json);
          }
          if (!isDone && isIncomingBranchOpen) {
            Avo.cliConflictResolveFailed({
              userId_: installIdOrUserId(),
              cliInvokedByCi: invokedByCi(),
              schemaId: head.schema.id,
              schemaName: head.schema.name,
              branchId: head.branch.id,
              branchName: head.branch.name,
            });
            throw new Error(
              `Incoming branch, ${
                incoming.branch.name
              }, has not been merged to Avo main.\n\nTo review and merge go to:\n${link(
                `https://www.avo.app/schemas/${nextAvoJson.schema.id}/branches/${incoming.branch.id}/diff`,
              )}\n\nOnce merged, run 'avo pull'. To skip this check use the --force flag.`,
            );
          } else {
            return Promise.resolve(json);
          }
        })
        .then((json) => {
          if (skipPullMaster) {
            return Promise.resolve(json);
          }
          return promptPullMaster(json);
        })
        .then((json) => {
          Avo.cliConflictResolveSucceeded({
            userId_: installIdOrUserId(),
            cliInvokedByCi: invokedByCi(),
            schemaId: head.schema.id,
            schemaName: head.schema.name,
            branchId: head.branch.id,
            branchName: head.branch.name,
          });
          report.success('Successfully resolved Avo merge conflicts');
          return validateAvoJson(json);
        });
    }),
  );
}

function loadAvoJson(): Promise<AvoJson> {
  return loadJsonFile('avo.json')
    .then(validateAvoJson)
    .catch((err) => {
      if (err.code === 'ENOENT') {
        throw new AvoError(
          `File ${file('avo.json')} does not exist. Run ${cmd('avo init')}`,
        );
      } else {
        throw err;
      }
    });
}

function loadAvoJsonOrInit({
  argv,
  skipPullMaster,
  skipInit,
}): Promise<AvoJson> {
  return pify(fs.readFile)('avo.json', 'utf8')
    .then((avoFile) => {
      if (hasMergeConflicts(avoFile)) {
        return resolveAvoJsonConflicts(avoFile, {
          argv,
          skipPullMaster,
        });
      }
      return Promise.resolve(JSON.parse(avoFile));
    })
    .then((json) =>
      Promise.resolve({
        ...json,
        force: argv.f === true,
        forceFeatures: argv.forceFeatures,
      }),
    )
    .then(validateAvoJson)
    .catch((error) => {
      if (error.code === 'ENOENT' && skipInit) {
        return Promise.resolve();
      }

      if (error.code === 'ENOENT') {
        report.info('Avo not initialized');
        return requireAuth(argv, init);
      }

      throw error;
    });
}

function writeAvoJson(json: AvoJson): Promise<AvoJson> {
  return writeJsonFile('avo.json', json, {
    indent: 2,
  }).then(() => json);
}

function codegen(
  json: AvoJson,
  { schema, sources: targets, warnings, success, errors },
) {
  const newJson: AvoJson = { ...JSON.parse(JSON.stringify(json)), schema };

  newJson.sources = newJson.sources.map((source) => {
    const target = targets.find(({ id }) => id === source.id);
    if (target) {
      return {
        ...source,
        actionId: target.actionId,
        name: target.name,
        id: target.id,
        path: source.path,
        interfacePath: source.interfacePath,
        branchId: target.branchId,
        updatedAt: target.updatedAt,
      };
    }
    return source;
  });

  const sourceTasks = targets.map((target) =>
    Promise.all(target.code.map((code) => writeFile(code.path, code.content))),
  );

  const avoJsonTask = writeAvoJson(newJson);

  Promise.all([avoJsonTask].concat(sourceTasks)).then(() => {
    if (errors !== undefined && errors !== null && errors !== '') {
      report.warn(`${errors}\n`);
    }

    if (
      warnings !== undefined &&
      warnings !== null &&
      Array.isArray(warnings)
    ) {
      warnings.forEach((warning) => {
        report.warn(warning);
      });
    }
    if (success !== undefined && success !== null && Array.isArray(success)) {
      success.forEach((success) => {
        report.success(success);
      });
    }

    report.success(
      `Analytics ${
        targets.length > 1 ? 'wrappers' : 'wrapper'
      } successfully updated`,
    );
    targets.forEach((target) => {
      const source = newJson.sources.find(({ id }) => id === target.id);
      report.tree('sources', [
        {
          name: source.name,
          children: target.code.map((code) => ({ name: code.path })),
        },
      ]);
    });
  });
}

function matchesSource(source, filter) {
  return source.name.toLowerCase() === filter.toLowerCase();
}

type ApiSourcesResult = {
  sources: [
    {
      id: string;
      name: string;
      filenameHint: string;
      canHaveInterfaceFile: boolean;
    },
  ];
};

function selectSource(sourceToAdd: string, json: AvoJson) {
  wait('Fetching sources');
  return api
    .request('POST', '/c/v1/sources', {
      origin: api.apiOrigin,
      auth: true,
      json: {
        schemaId: json.schema.id,
        branchId: json.branch.id,
      },
    })
    .then((data: ApiSourcesResult) => {
      cancelWait();
      const existingSources = json.sources ?? [];
      const sources = data.sources
        .filter((source) => !existingSources.find(({ id }) => source.id === id))
        .sort((a, b) => {
          if (a.name < b.name) return -1;
          if (a.name > b.name) return 1;
          return 0;
        });

      const prompts = [
        {
          type: 'fuzzypath',
          name: 'folder',
          excludePath: (maybeExcludePath) =>
            maybeExcludePath.startsWith('node_modules') ||
            maybeExcludePath.startsWith('.git'),
          itemType: 'directory',
          rootPath: '.',
          message: 'Select a folder to save the analytics wrapper in',
          default: '.',
          suggestOnly: false,
          depthLimit: 10,
        },
      ];

      if (!sourceToAdd) {
        const choices = sources.map((source) => ({
          value: source,
          name: source.name,
        }));

        prompts.unshift({
          type: 'list',
          name: 'source',
          message: 'Select a source to set up',
          // @ts-ignore
          choices,
          pageSize: 15,
        });
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename for the analytics wrapper',
          // @ts-ignore
          default(answers) {
            return answers.source.filenameHint;
          },
        });
      } else {
        const source = sources.find((soruceToFind) =>
          matchesSource(soruceToFind, sourceToAdd),
        );
        if (!source) {
          throw new AvoError(`Source ${sourceToAdd} does not exist`);
        }
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename for the library',
          // @ts-ignore
          default() {
            return source.filenameHint;
          },
        });
      }

      return inquirer.prompt(prompts).then(async (answer) => {
        let answerSource: any;
        if (sourceToAdd) {
          answerSource = sources.find((soruceToFind) =>
            matchesSource(soruceToFind, sourceToAdd),
          );
        } else {
          answerSource = answer.source;
        }
        const moreAnswers = await inquirer.prompt(
          answerSource.canHaveInterfaceFile === true
            ? [
                {
                  type: 'fuzzypath',
                  name: 'folder',
                  excludePath: (maybeExcludePath) =>
                    maybeExcludePath.startsWith('node_modules') ||
                    maybeExcludePath.startsWith('.git'),
                  itemType: 'directory',
                  rootPath: '.',
                  message:
                    'Select a folder to save the analytics wrapper interface file in',
                  default: '.',
                  suggestOnly: false,
                  depthLimit: 10,
                },
                {
                  type: 'input',
                  name: 'interfaceFilename',
                  message: (_answers) =>
                    'Select a filename for the analytics wrapper interface file',
                  // @ts-ignore
                  default() {
                    return answerSource.filenameHint;
                  },
                },
              ]
            : [],
        );
        const hasMultiPath = moreAnswers.interfaceFilename != null;
        const relativeMainPath = path.relative(
          process.cwd(),
          path.join(path.resolve(answer.folder), answer.filename),
        );
        let relativeInterfacePath = relativeMainPath;
        if (hasMultiPath) {
          relativeInterfacePath = path.relative(
            process.cwd(),
            path.join(
              path.resolve(answer.folder),
              moreAnswers.interfaceFilename,
            ),
          );
        }
        let source;
        if (sourceToAdd) {
          source = sources.find((sourceToFind) =>
            matchesSource(sourceToFind, sourceToAdd),
          );
          source = {
            id: source.id,
            name: source.name,
            path: relativeMainPath,
            interfacePath: relativeInterfacePath,
          };
        } else {
          source = {
            id: answer.source.id,
            name: answer.source.name,
            path: relativeMainPath,
            interfacePath: relativeInterfacePath,
          };
        }

        const newJson = { ...json, sources: [...(json.sources ?? []), source] };
        report.info(`Added source ${source.name} to the project`);
        report.info(
          `Run 'avo pull "${source.name}"' to pull the latest analytics wrapper for this source`,
        );
        return newJson;
      });
    });
}

type ApiPullResult = {
  ok: boolean;
  branchName: string;
  reason: string;
  closedAt: string; // Datestring
  sources: [];
  warnings: object;
  success: object;
  errors: object;
  schema: object;
};

function pull(sourceFilter, json: AvoJson): Promise<void> {
  const sources = sourceFilter
    ? [json.sources.find((source) => matchesSource(source, sourceFilter))]
    : json.sources;
  const sourceNames = sources.map((source) => source.name);
  wait(`Pulling ${sourceNames.join(', ')}`);

  return getMasterStatus(json)
    .then((masterStatus) => {
      if (masterStatus === BranchStatus.BRANCH_NOT_UP_TO_DATE) {
        report.warn(
          `Your branch '${json.branch.name}' is not up to date with Avo main. To merge latest Avo main into the branch, run 'avo merge main'.`,
        );
      }
      return Promise.resolve();
    })
    .then(() =>
      api.request('POST', '/c/v1/pull', {
        origin: api.apiOrigin,
        auth: true,
        json: {
          schemaId: json.schema.id,
          branchId: json.branch.id,
          sources: sources.map((source) => ({
            id: source.id,
            path: source.path,
            interfacePath: source.interfacePath,
          })),
          force: json.force ?? false,
          forceFeatures: json.forceFeatures,
        },
      }),
    )
    .then((result: ApiPullResult) => {
      cancelWait();
      if (result.ok) {
        codegen(json, result);
      } else {
        report.error(
          `Branch ${result.branchName} was ${
            result.reason
          } ${dateFns.formatDistance(
            new Date(),
            new Date(result.closedAt),
          )} ago. Pick another branch.`,
        );
        checkout(null, json).then((data) => pull(sourceFilter, data));
      }
    });
}

type FileMatch = {
  line: number;
  start: number;
  end: number;
  lineContents: string;
};
function findMatches(data: string, regex: RegExp): FileMatch[] {
  const isGlobal = regex.global;
  const lines = data.split('\n');
  const fileMatches = [];
  let lastIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineContents = lines[index];
    const line = lastIndex + index;
    let match;

    while (true) {
      match = regex.exec(lineContents);
      if (!match) break;

      const start = match.index;
      const end = match.index + match[0].length;

      fileMatches.push({
        line,
        start,
        end,
        lineContents,
      });

      if (!isGlobal) break;
    }
  }

  lastIndex += lines.length;

  return fileMatches;
}

function getEventMap(data: string, verbose: boolean): string[] | null {
  const searchFor = 'AVOEVENTMAP:';
  const lines = data.split('\n').filter((line) => line.indexOf(searchFor) > -1);
  if (lines.length === 1) {
    let line = lines[0].substring(
      lines[0].indexOf(searchFor) + searchFor.length,
    );
    line = line.substring(line.indexOf('['), line.indexOf(']') + 1);
    const eventMap = JSON.parse(line);
    return eventMap;
  }
  if (verbose) {
    report.error('No event map found');
  }
  return null;
}

function getModuleMap(data: string, verbose: boolean): string[] | null {
  const searchFor = 'AVOMODULEMAP:';
  const lines = data.split('\n').filter((line) => line.indexOf(searchFor) > -1);
  if (lines.length === 1) {
    let line = lines[0].substring(
      lines[0].indexOf(searchFor) + searchFor.length,
    );
    line = line.substring(line.indexOf('"'), line.lastIndexOf('"') + 1);
    const moduleMap = JSON.parse(line);
    return moduleMap;
  }
  if (verbose) {
    report.error('No module map found');
  }
  return null;
}

function getSource(argv, json: AvoJson): Promise<[string, AvoJson]> {
  if (!json.sources || !json.sources.length) {
    report.info('No sources configured.');
    return requireAuth(argv, () => {
      if (argv.source) {
        report.info(`Setting up source "${argv.source}"`);
      }
      return selectSource(argv.source, json).then((sourceJson) => [
        argv.source,
        sourceJson,
      ]);
    });
  }
  if (
    argv.source &&
    !json.sources.find((source) => matchesSource(source, argv.source))
  ) {
    report.error(`Source ${argv.source} not found`);
    return requireAuth(argv, () =>
      selectSource(argv.source, json).then((sourceJson) => [
        argv.source,
        sourceJson,
      ]),
    );
  }
  return Promise.resolve([argv.source, json]);
}

function status(source: string, json, argv: any): void {
  let sources = source
    ? json.sources.filter((s) => matchesSource(s, source))
    : json.sources;

  sources = sources.filter(({ analysis }) => analysis !== false);
  const fileCache = walk({
    ignoreFiles: ['.gitignore'],
    follow: false,
  }).then((results) =>
    Promise.all(
      results
        .filter((result) => !result.startsWith('.git'))
        .map((resultPath) =>
          pify(fs.lstat)(resultPath)
            .then((stats) => {
              if (stats.isSymbolicLink()) {
                return [];
              }
              return pify(fs.readFile)(resultPath, 'utf8')
                .then((data) => [resultPath, data])
                .catch((error) => {
                  if (argv.verbose) {
                    report.warn(`Failed to parse file: ${resultPath}`, error);
                  }
                });
            })
            .catch((error) => {
              if (argv.verbose) {
                report.warn(`Failed to read file stats: ${resultPath}`, error);
              }
            }),
        ),
    ).then((cachePairs) => Object.fromEntries(cachePairs)),
  );

  fileCache
    .then((cache) => {
      sources = Promise.all(
        sources.map((source) =>
          pify(fs.readFile)(source.path, 'utf8').then((data) => {
            const eventMap = getEventMap(data, argv.verbose);
            if (eventMap !== null) {
              const moduleMap = getModuleMap(data, argv.verbose);
              const sourcePath = path.parse(source.path);
              const moduleName =
                source.analysis?.module ??
                moduleMap ??
                sourcePath.name ??
                'Avo';

              const sourcePathExts = [];

              if (sourcePath.ext === '.js' || sourcePath.ext === '.ts') {
                sourcePathExts.push('js');
                sourcePathExts.push('jsx');
                sourcePathExts.push('ts');
                sourcePathExts.push('tsx');
              } else if (
                sourcePath.ext === '.java' ||
                sourcePath.ext === '.kt'
              ) {
                sourcePathExts.push('java');
                sourcePathExts.push('kt');
              } else if (
                sourcePath.ext === '.m' ||
                sourcePath.ext === '.swift'
              ) {
                sourcePathExts.push('m');
                sourcePathExts.push('swift');
              } else if (sourcePath.ext === '.re') {
                sourcePathExts.push('re');
                sourcePathExts.push('res');
              } else {
                sourcePathExts.push(sourcePath.ext.substring(1));
              }

              if (argv.verbose) {
                console.log(
                  'Looking in files with extensions:',
                  sourcePathExts,
                );
              }

              const globs: Minimatch[] = [
                new Minimatch(
                  source.analysis?.glob ??
                    `**/*.+(${sourcePathExts.join('|')})`,
                  {},
                ),
                new Minimatch(`!${source.path}`, {}),
              ];

              const lookup: { [key: string]: string } = {};
              Object.entries(cache).forEach(([cachePath, value]) => {
                if (globs.every((mm) => mm.match(cachePath))) {
                  lookup[cachePath] = value;
                }
              });

              if (argv.verbose) {
                const combinedPaths: string[] = [];

                Object.entries(lookup).forEach(([path, _data]) => {
                  combinedPaths.push(path);
                });

                report.info(`Looking for events: ${eventMap.join('\n')}`);
                report.info(`Looking in module: ${moduleName}`);
                report.info(`Looking in files: ${combinedPaths.join('\n')}`);
              }

              return Promise.all(
                eventMap.map((eventName) => {
                  const re = new RegExp(
                    `(${moduleName}\\.${eventName}|\\[${moduleName} ${eventName})`,
                  );
                  const results = Object.entries(lookup)
                    .map(([path, data]) => {
                      const results = findMatches(data, re);
                      return results.length ? [[path, results]] : [];
                    })
                    .flat();
                  return [eventName, Object.fromEntries(results)];
                }),
              ).then((results) => ({
                ...source,
                results: Object.fromEntries(results),
              }));
            }
            return source;
          }),
        ),
      );

      return sources.then((sources) => {
        report.tree(
          'sources',
          sources.map((source) => ({
            name: `${source.name} (${source.path})`,
            children: Object.entries(source.results).map(
              ([eventName, results]) => ({
                name: eventName,
                children:
                  Object.keys(results).length > 0
                    ? Object.entries(results).map(([matchFile, result]) => ({
                        name: `used in ${matchFile}: ${result.length}${
                          result.length === 1 ? ' time' : ' times'
                        }`,
                      }))
                    : [
                        {
                          name: `${logSymbols.error} no usage found`,
                        },
                      ],
              }),
            ),
          })),
        );

        const totalEvents = sources
          .map(({ results }) => Object.keys(results).length)
          .reduce(sum, 0);

        const missingEvents = sources
          .map(
            ({ results }) =>
              Object.values(results).filter(
                (missing) => Object.keys(missing).length === 0,
              ).length,
          )
          .reduce(sum, 0);

        if (missingEvents === 0) {
          if (totalEvents === 0) {
            report.error(
              'no events found in the avo file - please run avo pull',
            );
          } else {
            report.info(`${totalEvents} events seen in code`);
          }
        } else {
          report.info(
            `${
              totalEvents - missingEvents
            } of ${totalEvents} events seen in code`,
          );
        }
        if (missingEvents > 0) {
          report.error(
            `${missingEvents} missing ${
              missingEvents > 1 ? 'events' : 'event'
            }`,
          );
          report.tree(
            'missingEvents',
            sources.map((source) => ({
              name: `${source.name} (${source.path})`,
              children: Object.entries(source.results)
                .map(([eventName, results]) =>
                  Object.keys(results).length === 0
                    ? [
                        {
                          name: `${red(eventName)}: no usage found`,
                        },
                      ]
                    : [],
                )
                .flat(),
            })),
          );
          process.exit(1);
        }
      });
    })
    .catch((error) => {
      if (error.code === 'ENOENT') {
        report.error(
          "Avo file not found. Run 'avo pull' to pull latest Avo files.",
        );
      } else {
        throw error;
      }
    });
}

/// //////////////////////////////////////////////////////////////////////
// AUTH

function _getLoginUrl(callbackUrl: string): string {
  return `${api.authOrigin}/auth/cli?state=${encodeURIComponent(
    nonce,
  )}&redirect_uri=${encodeURIComponent(callbackUrl)}`;
}

function _getCallbackUrl(port?: number): string {
  if (port === undefined) {
    return 'urn:ietf:wg:oauth:2.0:oob';
  }
  return `http://localhost:${port}`;
}

function _getTokensFromAuthorizationCode(
  code: string | string[],
  callbackUrl: string,
): Promise<LastAccessToken> {
  return api
    .request('POST', '/auth/token', {
      origin: api.apiOrigin,
      json: {
        token: code,
        redirect_uri: callbackUrl,
      },
    })
    .then(
      (data: ApiTokenResult) => {
        if (!data.idToken && !data.refreshToken) {
          throw INVALID_CREDENTIAL_ERROR;
        }
        lastAccessToken = {
          expiresAt: Date.now() + data.expiresIn * 1000,
          ...data,
        };
        return lastAccessToken;
      },
      () => {
        throw INVALID_CREDENTIAL_ERROR;
      },
    );
}

function _respondWithRedirect(
  req: http.IncomingMessage,
  res: http.ServerResponse<http.IncomingMessage>,
  Location: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    res.writeHead(302, { Location });
    res.end();
    req.socket.destroy();
    resolve();
  });
}

function _loginWithoutLocalhost() {
  const callbackUrl = _getCallbackUrl();
  const authUrl = _getLoginUrl(callbackUrl);

  report.info(`Visit this URL on any device to login: ${new URL(authUrl)}`);

  return open(authUrl);
}

type FirebaseSignInProvider = 'custom' | 'google.com' | 'password';

type LoginResult = {
  user: {
    cli: boolean;
    iss: string;
    aud: string;
    auth_time: number;
    user_id: string;
    sub: string;
    iat: number;
    email: string;
    email_verified: boolean;
    firebase: {
      identities: object;
      sign_in_provider: FirebaseSignInProvider;
    };
  };
  tokens: {
    expiresAt: number;
    kind: string;
    idToken: string;
    refreshToken: string;
    expiresIn: string;
    isNewUser: boolean;
  };
};

function _loginWithLocalhost(port: number) {
  return new Promise((resolve, reject) => {
    const callbackUrl = _getCallbackUrl(port);
    const authUrl = _getLoginUrl(callbackUrl);

    let server = http.createServer((req, res) => {
      let tokens;
      const query = url.parse(req.url, true).query ?? {};

      if (query.state === nonce && isString(query.code)) {
        return _getTokensFromAuthorizationCode(query.code, callbackUrl)
          .then((result) => {
            tokens = result;
            return _respondWithRedirect(
              req,
              res,
              `${api.authOrigin}/auth/cli/success`,
            );
          })
          .then(() => {
            cancelWait();
            server.close();
            return resolve({
              user: jwt.decode(tokens.idToken),
              tokens,
            });
          })
          .catch(() =>
            _respondWithRedirect(req, res, `${api.authOrigin}/auth/cli/error`),
          );
      }
      return _respondWithRedirect(req, res, `${api.authOrigin}/auth/cli/error`);
    });

    server = httpShutdown(server);

    server.listen(port, () => {
      report.info(`Visit this URL on any device to login: ${link(authUrl)}`);
      wait('Waiting for authentication...');

      open(authUrl);
    });

    server.on('error', () => {
      _loginWithoutLocalhost().then(resolve, reject);
    });
  });
}

function login() {
  return _getPort().then(_loginWithLocalhost, _loginWithoutLocalhost);
}

function logout(refreshToken: string): void {
  if (lastAccessToken.refreshToken === refreshToken) {
    lastAccessToken = {};
  }
  const tokens = conf.get('tokens');
  const currentToken = tokens.refreshToken;
  if (refreshToken === currentToken) {
    conf.delete('user');
    conf.delete('tokens');
  }
}

function parseForceFeaturesParam(forceFeatures: string | undefined): string[] {
  return forceFeatures?.split(',').map((it) => it.trim());
}

yargs(hideBin(process.argv)) // eslint-disable-line no-unused-expressions
  .usage('$0 command')
  .scriptName('avo')
  .version(pkg.version)
  .option('v', {
    alias: 'verbose',
    default: false,
    describe: 'make output more verbose',
    type: 'boolean',
  })
  .command({
    command: 'track-install',
    desc: false,
    handler: async (argv) => {
      try {
        Avo.cliInstalled({
          userId_: installIdOrUserId(),
          cliInvokedByCi: invokedByCi(),
        }).catch((error) => {
          if (argv.verbose) {
            console.error('Request to track cli installed failed', error);
          }
        });
      } catch (error) {
        console.error('Unexpected error failed to track cli installed', error);
      }
    },
  })
  .command({
    command: 'init',
    desc: 'Initialize an Avo workspace in the current folder',
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipPullMaster: false, skipInit: true })
        .then((json) => {
          if (json) {
            Avo.cliInvoked({
              schemaId: json.schema.id,
              schemaName: json.schema.name,
              branchId: json.branch.id,
              branchName: json.branch.name,
              userId_: installIdOrUserId(),
              cliAction: Avo.CliAction.INIT,
              cliInvokedByCi: invokedByCi(),
              force: undefined,
              forceFeatures: undefined,
            });
            report.info(
              `Avo is already initialized for workspace ${cyan(
                json.schema.name,
              )} (${file('avo.json')} exists)`,
            );
            return Promise.resolve();
          }

          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.INIT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          return requireAuth(argv, () =>
            init()
              .then(writeAvoJson)
              .then(() => {
                report.info(
                  "Run 'avo pull' to pull analytics wrappers from Avo",
                );
              }),
          );
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.INIT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
        });
    },
  })
  .command({
    command: 'pull [source]',
    desc: 'Pull analytics wrappers from Avo workspace',
    builder: (yargs) =>
      yargs
        .option('branch', {
          describe: 'Name of Avo branch to pull from',
          type: 'string',
        })
        .option('f', {
          alias: 'force',
          describe:
            'Proceed ignoring the unsupported features for given source',
          default: false,
          type: 'boolean',
        })
        .option('forceFeatures', {
          describe:
            'Optional comma separated list of features to force enable, pass unsupported name to get the list of available features',
          default: undefined,
          type: 'string',
        }),
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.PULL,
            cliInvokedByCi: invokedByCi(),
            force: argv.f === true,
            forceFeatures: parseForceFeaturesParam(argv.forceFeatures),
          });
          requireAuth(argv, () => {
            if (argv.branch && json.branch.name !== argv.branch) {
              return checkout(argv.branch, json)
                .then((data) => getSource(argv, data))
                .then(([source, data]) => pull(source, data));
            }
            report.info(`Pulling from branch '${json.branch.name}'`);
            return getSource(argv, json).then(([source, data]) =>
              pull(source, data),
            );
          });
        })
        .catch((error) => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.PULL,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          throw error;
        });
    },
  })
  .command({
    command: 'checkout [branch]',
    aliases: ['branch'],
    desc: 'Switch branches',
    handler: (argv) =>
      loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CHECKOUT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          report.info(`Currently on branch '${json.branch.name}'`);
          requireAuth(argv, () =>
            checkout(argv.branch, json).then(writeAvoJson),
          );
        })
        .catch((error) => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CHECKOUT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          throw error;
        }),
  })
  .command({
    command: 'source <command>',
    desc: 'Manage sources for the current project',
    builder: (yargs) => {
      yargs
        .command({
          command: '$0',
          desc: 'List sources in this project',
          handler: (argv) => {
            loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
              .then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });

                if (!json.sources || !json.sources.length) {
                  report.info(
                    `No sources defined in ${file('avo.json')}. Run ${cmd(
                      'avo source add',
                    )} to add sources`,
                  );
                  return;
                }

                report.info('Sources in this project:');
                report.tree(
                  'sources',
                  json.sources.map((source) => ({
                    name: source.name,
                    children: [{ name: source.path }],
                  })),
                );
              })
              .catch((error) => {
                Avo.cliInvoked({
                  schemaId: 'N/A',
                  schemaName: 'N/A',
                  branchId: 'N/A',
                  branchName: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });
                throw error;
              });
          },
        })
        .command({
          command: 'add [source]',
          desc: 'Add a source to this project',
          handler: (argv) => {
            loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
              .then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });

                requireAuth(argv, () => {
                  selectSource(argv.source, json).then(writeAvoJson);
                });
              })
              .catch((error) => {
                Avo.cliInvoked({
                  schemaId: 'N/A',
                  schemaName: 'N/A',
                  branchId: 'N/A',
                  branchName: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });
                throw error;
              });
          },
        })
        .command({
          command: 'remove [source]',
          aliases: ['rm'],
          desc: 'Remove a source from this project',
          handler: (argv) => {
            loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
              .then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });

                if (!json.sources || !json.sources.length) {
                  report.warn(
                    `No sources defined in ${file('avo.json')}. Run ${cmd(
                      'avo source add',
                    )} to add sources`,
                  );
                  return;
                }

                const getSourceToRemove = (argv, json) => {
                  if (argv.source) {
                    return Promise.resolve(
                      json.sources.find((source) =>
                        matchesSource(source, argv.source),
                      ),
                    );
                  }

                  const choices = json.sources.map((source) => ({
                    value: source,
                    name: source.name,
                  }));

                  return inquirer
                    .prompt({
                      type: 'list',
                      name: 'source',
                      message: 'Select a source to remove',
                      choices,
                      pageSize: 15,
                    })
                    .then((answer) => answer.source);
                };

                getSourceToRemove(argv, json).then((targetSource) => {
                  if (!targetSource) {
                    report.error(`Source ${argv.source} not found in project.`);
                    return Promise.resolve();
                  }

                  return inquirer
                    .prompt([
                      {
                        type: 'confirm',
                        name: 'remove',
                        default: true,
                        message: `Are you sure you want to remove source ${targetSource.name} from project`,
                      },
                    ])
                    .then((answer) => {
                      if (answer.remove) {
                        const sources = (json.sources ?? []).filter(
                          (source) => source.id !== targetSource.id,
                        );
                        const newJson = { ...json, sources };
                        return writeAvoJson(newJson).then(() => {
                          // XXX ask to remove file as well?
                          report.info(
                            `Removed source ${targetSource.name} from project`,
                          );
                        });
                      }

                      report.info(
                        `Did not remove source ${targetSource.name} from project`,
                      );
                      return Promise.resolve();
                    });
                });
              })
              .catch((error) => {
                Avo.cliInvoked({
                  schemaId: 'N/A',
                  schemaName: 'N/A',
                  branchId: 'N/A',
                  branchName: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });
                throw error;
              });
          },
        });
    },
  })
  .command({
    command: 'status [source]',
    desc: 'Show the status of the Avo implementation',
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.STATUS,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          report.info(`Currently on branch '${json.branch.name}'`);
          return getSource(argv, json);
        })
        .then(([source, json]) => status(source, json, argv))
        .catch((error) => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.STATUS,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          throw error;
        });
    },
  })
  .command({
    command: 'merge main',
    aliases: ['merge master'],
    desc: 'Pull the Avo main branch into your current branch',
    builder: (yargs) =>
      yargs.option('f', {
        alias: 'force',
        describe: 'Proceed with merge when incoming branch is open',
        default: false,
        type: 'boolean',
      }),
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipPullMaster: true, skipInit: false })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.MERGE,
            cliInvokedByCi: invokedByCi(),
            force: json.force,
            forceFeatures: undefined,
          });

          return requireAuth(argv, () => pullMaster(json).then(writeAvoJson));
        })
        .catch((error) => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.MERGE,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          throw error;
        });
    },
  })
  .command({
    command: 'conflict',
    aliases: ['resolve', 'conflicts'],
    desc: 'Resolve git conflicts in Avo files',
    handler: (argv) =>
      pify(fs.readFile)('avo.json', 'utf8')
        .then((avoFile) => {
          if (hasMergeConflicts(avoFile)) {
            return requireAuth(argv, () =>
              resolveAvoJsonConflicts(avoFile, {
                argv,
                skipPullMaster: false,
              }).then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.CONFLICT,
                  cliInvokedByCi: invokedByCi(),
                  force: undefined,
                  forceFeatures: undefined,
                });
                pull(null, json);
              }),
            );
          }
          report.info(
            "No git conflicts found in avo.json. Run 'avo pull' to resolve git conflicts in other Avo files.",
          );
          const json = JSON.parse(avoFile);
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CONFLICT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          return Promise.resolve(json);
        })
        .catch((error) => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CONFLICT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          throw error;
        }),
  })
  .command({
    command: 'edit',
    desc: 'Open the Avo workspace in your browser',
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipInit: false, skipPullMaster: false })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.EDIT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });

          const { schema } = json;
          const schemaUrl = `https://www.avo.app/schemas/${schema.id}`;
          report.info(
            `Opening ${cyan(schema.name)} workspace in Avo: ${link(schemaUrl)}`,
          );
          open(schemaUrl);
        })
        .catch((error) => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.EDIT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          throw error;
        });
    },
  })
  .command({
    command: 'login',
    desc: 'Log into the Avo platform',
    handler: () => {
      const command = () => {
        const user = conf.get('user');
        if (user) {
          report.info(`Already logged in as ${email(user.email)}`);
          return;
        }
        login()
          .then((result: LoginResult) => {
            conf.set('user', result.user);
            conf.set('tokens', result.tokens);

            Avo.signedIn({
              userId_: result.user.user_id,
              email: result.user.email,
              authenticationMethod: Avo.AuthenticationMethod.CLI,
            });

            report.success(`Logged in as ${email(result.user.email)}`);
          })
          .catch(() => {
            Avo.signInFailed({
              userId_: conf.get('avo_install_id'),
              emailInput: '', // XXX this is not passed back here
              signInError: Avo.SignInError.UNKNOWN,
            });
          });
      };

      loadAvoJson()
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGIN,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          command();
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGIN,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          command();
        });
    },
  })
  .command({
    command: 'logout',
    desc: 'Log out from the Avo platform',
    handler: () => {
      const command = () => {
        const user = conf.get('user');
        const tokens = conf.get('tokens');
        const currentToken = tokens.refreshToken;
        const token = currentToken;
        api.setRefreshToken(token);
        if (token) {
          logout(token);
        }
        if (token || user || tokens) {
          let msg = 'Logged out';
          if (token === currentToken) {
            if (user) {
              msg += ` from ${bold(user.email)}`;
            }
          } else {
            msg += ` token "${bold(token)}"`;
          }
          report.log(msg);
        } else {
          report.log("No need to logout, you're not logged in");
        }
      };

      loadAvoJson()
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGOUT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          command();
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGOUT,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          command();
        });
    },
  })
  .command({
    command: 'whoami',
    desc: 'Shows the currently logged in username',
    handler: (argv) => {
      const command = () => {
        requireAuth(argv, () => {
          if (conf.has('user')) {
            const user = conf.get('user');
            report.info(`Logged in as ${email(user.email)}`);
          } else {
            report.warn('Not logged in');
          }
        });
      };

      loadAvoJson()
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.WHOAMI,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          command();
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            schemaName: 'N/A',
            branchId: 'N/A',
            branchName: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.WHOAMI,
            cliInvokedByCi: invokedByCi(),
            force: undefined,
            forceFeatures: undefined,
          });
          command();
        });
    },
  })

  .demandCommand(1, 'must provide a valid command')
  .recommendCommands()
  .help().argv;

/// ///////////////// ////////
// catch unhandled promises

process.on('unhandledRejection', (err) => {
  cancelWait();

  if (!(err instanceof Error) && !(err instanceof AvoError)) {
    report.error(
      new AvoError(`Promise rejected with value: ${util.inspect(err)}`),
    );
  } else {
    // @ts-ignore
    report.error(err.message);
  }
  // @ts-ignore
  // console.error(err.stack);

  process.exit(1);
});
