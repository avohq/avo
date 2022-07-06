#!/usr/bin/env node
import ora from 'ora';
import chalk from 'chalk';
import minimatch from 'minimatch';
import _ from 'lodash';
import dateFns from 'date-fns';
import fs from 'fs';
import http from 'http';
import inquirer from 'inquirer';
import jwt from 'jsonwebtoken';
import loadJsonFile from 'load-json-file';
import logSymbols from 'log-symbols';
import opn from 'opn';
import path from 'path';
import pify from 'pify';
import portfinder from 'portfinder';
import querystring from 'querystring';
import got from 'got';
import report from 'yurnalist';
import semver from 'semver';
import updateNotifier from 'update-notifier';
import url from 'url';
import util from 'util';
import { v4 as uuidv4 } from 'uuid';
import walk from 'ignore-walk';
import writeFile from 'write';
import writeJsonFile from 'write-json-file';
import Configstore from 'configstore';
import Inspector from 'node-avo-inspector';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import httpShutdown from 'http-shutdown';
import fuzzypath from 'inquirer-fuzzy-path';

import Avo from './Avo.js';

const pkg = JSON.parse(fs.readFileSync(new URL('package.json', import.meta.url)));

const { Minimatch } = minimatch;
const {
  cyan, gray, red, bold, underline,
} = chalk;


/// //////////////////////////////////////////////////////////////////////
// LOGGING

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

const nonce = _.random(1, 2 << 29).toString();

portfinder.basePort = 9005;
const _getPort = portfinder.getPortPromise;

function AvoError(message, options = {}) {
  this.name = 'AvoError';
  this.message = message;
  this.children = options.children || [];
  this.status = options.status || 500;
  this.exit = options.exit || 1;
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

// in-memory cache, so we have it for successive calls
let lastAccessToken = {};
let accessToken;
let refreshToken;
let commandScopes;

/// //////////////////////////////////////////////////////////////////////
// REQUEST HANDLING

function responseToError(response) {
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
    body.error = {
      message: response.statusCode === 404 ? 'Not Found' : 'Unknown Error',
    };
  }

  const message = `HTTP Error: ${response.statusCode}, ${body.error.message
    || body.error}`;

  let exitCode;
  if (response.statusCode >= 500) {
    // 5xx errors are unexpected
    exitCode = 2;
  } else {
    // 4xx errors happen sometimes
    exitCode = 1;
  }

  _.unset(response, 'request.headers');
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
    got(options).json().then((response) => {
      if (response.statusCode >= 400) {
        return reject(responseToError(response));
      }
      return resolve(response);
    }).catch((err) => reject(
      new AvoError(`Server Error. ${err.message}`, {
        original: err,
        exit: 2,
      }),
    ));
  });
}

const _appendQueryData = (urlPath, data) => {
  let returnPath = urlPath;
  if (data && _.size(data) > 0) {
    returnPath += _.includes(returnPath, '?') ? '&' : '?';
    returnPath += querystring.stringify(data);
  }
  return returnPath;
};

function _refreshAccessToken(refreshToken) {
  return api // eslint-ignore
    .request('POST', '/auth/refresh', {
      origin: api.apiOrigin,
      json: {
        token: refreshToken,
      },
    })
    .then(
      (data) => {
        if (!_.isString(data.idToken)) {
          throw INVALID_CREDENTIAL_ERROR;
        }
        lastAccessToken = _.assign(
          {
            expiresAt: Date.now() + data.expiresIn * 1000,
            refreshToken,
          },
          data,
        );

        const currentRefreshToken = _.get(conf.get('tokens'), 'refreshToken');
        if (refreshToken === currentRefreshToken) {
          conf.set('tokens', lastAccessToken);
        }

        return lastAccessToken;
      },
      (err) => {
        throw INVALID_CREDENTIAL_ERROR;
      },
    );
}

function getAccessToken(refreshToken) {
  if (_haveValidAccessToken(refreshToken)) {
    return Promise.resolve(lastAccessToken);
  }

  return _refreshAccessToken(refreshToken);
}

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
      : getAccessToken(refreshToken, commandScopes);
  },
  addRequestHeaders(reqOptions) {
    // Runtime fetch of Auth singleton to prevent circular module dependencies
    _.set(reqOptions, ['headers', 'User-Agent'], `AvoCLI/${pkg.version}`);
    _.set(reqOptions, ['headers', 'X-Client-Version'], `AvoCLI/${pkg.version}`);
    return api.getAccessToken().then((result) => {
      _.set(reqOptions, 'headers.authorization', `Bearer ${result.idToken}`);
      return reqOptions;
    });
  },
  request(method, resource, options) {
    const validMethods = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'];

    if (!validMethods.includes(method)) {
      method = 'GET';
    }

    const reqOptions = {
      method,
      decompress: true,
      headers: options.headers || {},
    };

    if (options.query) {
      resource = _appendQueryData(resource, options.query);
    }

    if (method === 'GET') {
      resource = _appendQueryData(resource, options.json);
    } else if (_.size(options.json) > 0) {
      reqOptions.json = options.json;
    } else if (_.size(options.form) > 0) {
      reqOptions.form = options.form;
    }

    reqOptions.url = options.origin + resource;

    let requestFunction = function () {
      return _request(reqOptions);
    };
    if (options.auth === true) {
      requestFunction = function () {
        return api
          .addRequestHeaders(reqOptions)
          .then((reqOptionsWithToken) => _request(reqOptionsWithToken));
      };
    }

    return requestFunction().catch((err) => {
      if (
        options.retryCodes
        && _.includes(
          options.retryCodes,
          _.get(err, 'context.response.statusCode'),
        )
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

  logEvent: function logEvent(userId, eventName, eventProperties) {
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
  },

  setUserProperties: () => {}, // noop
};

const inspector = new Inspector.AvoInspector({
  apiKey: '3UWtteG9HenZ825cYoYr', env: Inspector.AvoInspectorEnv.Prod, version: '1.0.0', appName: 'Avo CLI',
});

// setup Avo analytics
Avo.initAvo(
  { env: 'prod', inspector },
  { client: Avo.Client.CLI, version: pkg.version },
  {},
  customAnalyticsDestination,
);

function isLegacyAvoJson(json) {
  // check if legacy avo.json or un-initialized project
  return json.types || !json.schema;
}

function avoNeedsUpdate(json) {
  // if avo.json has version, and this binary has lower version number it needs updating
  return (
    json.avo && json.avo.version && semver.major(pkg.version) < json.avo.version
  );
}

const MERGE_CONFLICT_ANCESTOR = '|||||||';
const MERGE_CONFLICT_END = '>>>>>>>';
const MERGE_CONFLICT_SEP = '=======';
const MERGE_CONFLICT_START = '<<<<<<<';
function hasMergeConflicts(str) {
  return (
    str.includes(MERGE_CONFLICT_START)
    && str.includes(MERGE_CONFLICT_SEP)
    && str.includes(MERGE_CONFLICT_END)
  );
}

function extractConflictingFiles(str) {
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
          continue;
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

function validateAvoJson(json) {
  if (avoNeedsUpdate(json)) {
    throw new AvoError('Your avo CLI is outdated, please update');
  }

  if (isLegacyAvoJson(json)) {
    return init();
  }

  // augment the latest major version into avo.json
  json.avo = { ...json.avo || {}, version: semver.major(pkg.version) };

  return json;
}

const BRANCH_UP_TO_DATE = 'branch-up-to-date';
const BRANCH_NOT_UP_TO_DATE = 'branch-not-up-to-date';

function getMasterStatus(json) {
  if (json.branch.id == 'master') {
    return Promise.resolve(BRANCH_UP_TO_DATE);
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
    .then(({ pullRequired }) => (pullRequired
      ? BRANCH_NOT_UP_TO_DATE
      : BRANCH_UP_TO_DATE));
}

function pullMaster(json) {
  if (json.branch.name == 'main') {
    report.info('Your current branch is main');
    return Promise.resolve(json);
  }
  wait(json.force ? 'Force pulling main into branch' : 'Pulling main into branch');
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

function promptPullMaster(json) {
  wait('Check if branch is up to date with main');
  return getMasterStatus(json)
    .then((branchStatus) => {
      cancelWait();
      if (branchStatus == BRANCH_UP_TO_DATE) {
        return Promise.resolve([branchStatus]);
      } if (branchStatus == BRANCH_NOT_UP_TO_DATE) {
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
    })
    .then(([branchStatus, answer]) => {
      if (branchStatus == BRANCH_UP_TO_DATE) {
        report.success('Branch is up to date with main');
        return Promise.resolve(json);
      } if (answer.pull) {
        return pullMaster(json);
      }
      report.info('Did not pull main into branch');
      return Promise.resolve(json);
    });
}

function resolveAvoJsonConflicts(file, { argv, skipPullMaster }) {
  report.info('Resolving Avo merge conflicts');
  const files = extractConflictingFiles(file);
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
    head.avo.version != incoming.avo.version
    || head.schema.id != incoming.schema.id
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
    !_.isEqual(head.sources.map((s) => s.id), incoming.sources.map((s) => s.id))
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
  return requireAuth(argv, () => fetchBranches(nextAvoJson).then((branches) => {
    const isHeadBranchOpen = branches.find((branch) => branch.id == nextAvoJson.branch.id);

    const isIncomingBranchOpen = branches.find((branch) => branch.id == incoming.branch.id);

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
          head.branch.id == incoming.branch.id
            || incoming.branch.id == 'master'
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
        } if (!isDone && isIncomingBranchOpen) {
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
  }));
}

function loadAvoJson() {
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

function loadAvoJsonOrInit({ argv, skipPullMaster, skipInit }) {
  return pify(fs.readFile)('avo.json', 'utf8')
    .then((file) => {
      if (hasMergeConflicts(file)) {
        return resolveAvoJsonConflicts(file, {
          argv,
          skipPullMaster,
        });
      }
      return Promise.resolve(JSON.parse(file));
    })
    .then((json) => {
      json.force = argv.f === true;
      return Promise.resolve(json);
    })
    .then(validateAvoJson)
    .catch((error) => {
      if (error.code === 'ENOENT' && skipInit) {

      } else if (error.code === 'ENOENT') {
        report.info('Avo not initialized');
        return requireAuth(argv, init);
      } else {
        throw error;
      }
    });
}

function writeAvoJson(json) {
  return writeJsonFile('avo.json', json, {
    indent: 2,
  }).then(() => json);
}

function init() {
  const makeAvoJson = (schema) => {
    report.success(`Initialized for workspace ${cyan(schema.name)}`);

    return {
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
    };
  };
  wait('Initializing');
  return api
    .request('GET', '/c/v1/workspaces', {
      origin: api.apiOrigin,
      auth: true,
    })
    .then(({ workspaces }) => {
      cancelWait();
      const schemas = _.orderBy(workspaces, 'lastUsedAt', 'desc');
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
      } if (schemas.length === 0) {
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

function codegen(json, result) {
  const { schema } = result;
  const targets = result.sources;
  const newJson = { ..._.cloneDeep(json), schema };
  const { warnings } = result;
  const { errors } = result;

  newJson.sources = newJson.sources.map((source) => {
    const target = _.find(targets, (target) => target.id === source.id);
    if (target) {
      return {
        ...source,
        actionId: target.actionId,
        name: target.name,
        id: target.id,
        path: source.path,
        branchId: target.branchId,
        updatedAt: target.updatedAt,
      };
    }
    return source;
  });

  const sourceTasks = targets.map((target) => Promise.all(
    target.code.map((code) => writeFile(code.path, code.content)),
  ));

  const avoJsonTask = writeAvoJson(newJson);

  Promise.all(_.concat([avoJsonTask], sourceTasks)).then(() => {
    if (errors !== undefined && errors !== null && errors !== '') {
      report.warn(`${errors}\n`);
    }

    if (warnings !== undefined && warnings !== null && Array.isArray(warnings)) {
      warnings.forEach((warning) => {
        report.warn(warning);
      });
    }
    report.success(
      `Analytics ${
        targets.length > 1 ? 'wrappers' : 'wrapper'
      } successfully updated`,
    );
    targets.forEach((target) => {
      const source = _.find(newJson.sources, (source) => source.id === target.id);
      report.tree('sources', [
        {
          name: source.name,
          children: target.code.map((code) => ({ name: code.path })),
        },
      ]);
    });
  });
}

function selectSource(sourceToAdd, json) {
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
    .then((data) => {
      cancelWait();
      const existingSources = data.sources || [];
      let sources = _.sortBy(
        _.filter(
          result.sources,
          (source) => _.find(
            existingSources,
            (existingSource) => source.id === existingSource.id,
          ) === undefined,
        ),
        'name',
      );

      const prompts = [
        {
          type: 'fuzzypath',
          name: 'folder',
          excludePath: (path) => path.startsWith('node_modules') || path.startsWith('.git'),
          itemType: 'directory',
          rootPath: '.',
          message: 'Select a folder to save the analytics wrapper in',
          default: '.',
          suggestOnly: false,
          depthLimit: 10,
        },
      ];

      if (!sourceToAdd) {
        const choices = sources.map((source) => ({ value: source, name: source.name }));

        prompts.unshift({
          type: 'list',
          name: 'source',
          message: 'Select a source to set up',
          choices,
          pageSize: 15,
        });
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename for the analytics wrapper',
          default(answers) {
            return answers.source.filenameHint;
          },
        });
      } else {
        const source = _.find(sources, (source) => matchesSource(source, sourceToAdd));
        if (!source) {
          throw new AvoError(`Source ${sourceToAdd} does not exist`);
        }
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename for the library',
          default(answers) {
            return source.filenameHint;
          },
        });
      }

      return inquirer.prompt(prompts).then((answer) => {
        const relativePath = path.relative(
          process.cwd(),
          path.join(path.resolve(answer.folder), answer.filename),
        );
        let source;
        if (sourceToAdd) {
          source = _.find(sources, (source) => matchesSource(source, sourceToAdd));
          source = { id: source.id, name: source.name, path: relativePath };
        } else {
          source = {
            id: answer.source.id,
            name: answer.source.name,
            path: relativePath,
          };
        }
        sources = _.concat(json.sources || [], [source]);
        const newJson = { ...json, sources };
        report.info(`Added source ${source.name} to the project`);
        report.info(
          `Run 'avo pull "${source.name}"' to pull the latest analytics wrapper for this source`,
        );
        return newJson;
      });
    });
}

function fetchBranches(json) {
  wait('Fetching open branches');
  const payload = {
    origin: api.apiOrigin,
    auth: true,
    json: {
      schemaId: json.schema.id,
    },
  };
  return api.request('POST', '/c/v1/branches', payload).then((data) => {
    cancelWait();
    const branches = _.sortBy(data.branches, 'name');
    // The api still returns master for backwards comparability so we manually
    // update the branch name to main
    return branches.map(
      (branch) => (branch.name === 'master' ? { ...branch, name: 'main' } : branch),
    );
  });
}

function checkout(branchToCheckout, json) {
  return fetchBranches(json).then((branches) => {
    if (!branchToCheckout) {
      const choices = branches.map((branch) => ({ value: branch, name: branch.name }));
      const currentBranch = _.find(
        branches,
        (branch) => branch.id == json.branch.id,
      );
      return inquirer
        .prompt([
          {
            type: 'list',
            name: 'branch',
            message: 'Select a branch',
            default:
              currentBranch
              || _.find(branches, (branch) => branch.id == 'master'),
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
          json = {
            ...json,
            branch: {
              id: branch.id,
              name: branch.name,
            },
          };
          report.success(`Switched to branch '${branch.name}'`);
          return json;
        });
    }
    if (branchToCheckout == 'master') {
      report.info(
        'The master branch has been renamed to main. Continuing checkout with main branch...\'',
      );
    }
    const adjustedBranchToCheckout = branchToCheckout == 'master' ? 'main' : branchToCheckout;
    if (adjustedBranchToCheckout == json.branch.name) {
      // XXX should check here if json.branch.id === branch.id from server
      // if not, it indicates branch delete, same branch re-created and client is out of sync
      report.info(`Already on '${adjustedBranchToCheckout}'`);
      return json;
    }
    const branch = _.find(branches, (branch) => branch.name == adjustedBranchToCheckout);
    if (!branch) {
      report.error(
        `Branch '${adjustedBranchToCheckout}' does not exist. Run ${cmd(
          'avo checkout',
        )} to list available branches`,
      );
    } else {
      json = {
        ...json,
        branch: {
          id: branch.id,
          name: branch.name,
        },
      };
      report.success(`Switched to branch '${branch.name}'`);
      return json;
    }
  });
}

function matchesSource(source, filter) {
  return source.name.toLowerCase() === filter.toLowerCase();
}

function pull(sourceFilter, json) {
  const sources = sourceFilter
    ? [_.find(json.sources, (source) => matchesSource(source, sourceFilter))]
    : json.sources;
  const sourceNames = _.map(sources, (source) => source.name);
  wait(`Pulling ${sourceNames.join(', ')}`);

  return getMasterStatus(json)
    .then((status) => {
      if (status == BRANCH_NOT_UP_TO_DATE) {
        report.warn(
          `Your branch '${json.branch.name}' is not up to date with Avo main. To merge latest Avo main into the branch, run 'avo merge main'.`,
        );
      }
      return Promise.resolve();
    })
    .then(() => api.request('POST', '/c/v1/pull', {
      origin: api.apiOrigin,
      auth: true,
      json: {
        schemaId: json.schema.id,
        branchId: json.branch.id,
        sources: _.map(sources, (source) => ({ id: source.id, path: source.path })),
        force: json.force || false,
      },
    }))
    .then((result) => {
      cancelWait();
      if (result.ok) {
        codegen(json, result);
      } else {
        report.error(
          `Branch ${result.branchName} was ${
            result.reason
          } ${dateFns.distanceInWords(
            new Date(result.closedAt),
            new Date(),
          )} ago. Pick another branch.`,
        );
        checkout(null, json).then((json) => pull(sourceFilter, json));
      }
    });
}

function installIdOrUserId() {
  const installId = conf.get('avo_install_id');
  const user = conf.get('user');
  if (user && user.user_id) {
    return user.user_id;
  }
  return installId;
}

function invokedByCi() {
  return process.env.CI !== undefined;
}

function findMatches(data, regex) {
  const isGlobal = regex.global;
  const lines = data.split('\n');
  const fileMatches = [];
  let lastIndex = 0;

  for (let index = 0; index < lines.length; index++) {
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

function getEventMap(data) {
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
  return null;
}

function getModuleMap(data) {
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
  return null;
}

function getSource(argv, json) {
  if (!json.sources || !json.sources.length) {
    report.info('No sources configured.');
    return requireAuth(argv, () => {
      if (argv.source) {
        report.info(`Setting up source "${argv.source}"`);
      }
      return selectSource(argv.source, json).then((json) => [argv.source, json]);
    });
  } if (
    argv.source
    && !_.find(json.sources, (source) => matchesSource(source, argv.source))
  ) {
    report.error(`Source ${argv.source} not found`);
    return requireAuth(argv, () => selectSource(argv.source, json).then((json) => [argv.source, json]));
  }
  return Promise.resolve([argv.source, json]);
}

function status(source, json, argv) {
  let sources = source
    ? _.filter(json.sources, (s) => matchesSource(s, source))
    : json.sources;

  sources = sources.filter((source) => source.analysis !== false);
  const fileCache = walk({
    ignoreFiles: ['.gitignore'],
    follow: false,
  }).then((results) => {
    results = results.filter((path) => !path.startsWith('.git'));
    return Promise.all(
      results.map((path) => pify(fs.lstat)(path).then((stats) => {
        if (stats.isSymbolicLink()) {
          return [];
        }
        return pify(fs.readFile)(path, 'utf8').then((data) => [path, data]);
      })),
    ).then((cachePairs) => _.fromPairs(cachePairs));
  });

  fileCache
    .then((cache) => {
      sources = Promise.all(
        sources.map((source) => pify(fs.readFile)(source.path, 'utf8').then((data) => {
          const eventMap = getEventMap(data);
          if (eventMap !== null) {
            const moduleMap = getModuleMap(data);
            const sourcePath = path.parse(source.path);
            const moduleName = _.get(
              source,
              'analysis.module',
              moduleMap || sourcePath.name || 'Avo',
            );

            const sourcePathExts = [];

            if (sourcePath.ext === '.js' || sourcePath.ext === '.ts') {
              sourcePathExts.push('js');
              sourcePathExts.push('jsx');
              sourcePathExts.push('ts');
              sourcePathExts.push('tsx');
            } else if (sourcePath.ext === '.java' || sourcePath.ext === '.kt') {
              sourcePathExts.push('java');
              sourcePathExts.push('kt');
            } else if (sourcePath.ext === '.m' || sourcePath.ext === '.swift') {
              sourcePathExts.push('m');
              sourcePathExts.push('swift');
            } else if (sourcePath.ext === '.re') {
              sourcePathExts.push('re');
              sourcePathExts.push('res');
            } else {
              sourcePathExts.push(sourcePath.ext.substring(1));
            }

            if (argv.verbose) {
              console.log('Looking in files with extensions:', sourcePathExts);
            }

            const globs = [
              new Minimatch(
                _.get(source, 'analysis.glob', `**/*.+(${sourcePathExts.join('|')})`),
                {},
              ),
              new Minimatch(`!${source.path}`, {}),
            ];

            const lookup = _.pickBy(cache, (value, path) => _.every(globs, (mm) => mm.match(path)));

            return Promise.all(
              eventMap.map((eventName) => {
                const re = new RegExp(`(${moduleName}\\.${eventName}|\\[${moduleName} ${eventName})`);
                const results = _.flatMap(lookup, (data, path) => {
                  if (argv.verbose) {
                    report.info(`Looking for events in ${path}`);
                  }
                  const results = findMatches(data, re);
                  return results.length ? [[path, results]] : [];
                });
                return [eventName, _.fromPairs(results)];
              }),
            ).then((results) => ({ ...source, results: _.fromPairs(results) }));
          }
          return source;
        })),
      );

      return sources.then((sources) => {
        report.tree(
          'sources',
          sources.map((source) => ({
            name: `${source.name} (${source.path})`,
            children:
                  _.map(source.results, (results, eventName) => ({
                    name: eventName,
                    children:
                        _.size(results) > 0
                          ? _.map(results, (result, matchFile) => ({
                            name:
                                  `used in ${
                                    matchFile
                                  }: ${
                                    result.length
                                  }${result.length === 1 ? ' time' : ' times'}`,
                          }))
                          : [
                            {
                              name: `${logSymbols.error} no usage found`,
                            },
                          ],
                  })),
          })),
        );

        const totalEvents = _.sumBy(sources, (source) => _.size(source.results));
        const missingEvents = _.sumBy(sources, (source) => _.sum(
          _.map(source.results, (results, eventName) => (_.size(results) > 0 ? 0 : 1)),
        ));
        if (missingEvents === 0) {
          if (totalEvents === 0) {
            report.error('no events found in the avo file - please run avo pull');
          } else {
            report.info(`${totalEvents} events seen in code`);
          }
        } else {
          report.info(
            `${totalEvents
              - missingEvents} of ${totalEvents} events seen in code`,
          );
        }
        if (missingEvents > 0) {
          report.error(
            `${missingEvents} missing ${missingEvents > 1 ? 'events' : 'event'}`,
          );
          report.tree(
            'missingEvents',
            sources.map((source) => ({
              name: `${source.name} (${source.path})`,
              children:
                    _.flatMap(source.results, (results, eventName) => (_.size(results) === 0
                      ? [
                        {
                          name: `${red(eventName)}: no usage found`,
                        },
                      ]
                      : [])),
            })),
          );
          process.exit(1);
        }
      });
    })
    .catch((error) => {
      if (error.code == 'ENOENT') {
        report.error(
          "Avo file not found. Run 'avo pull' to pull latest Avo files.",
        );
      } else {
        throw error;
      }
    });
}

yargs(hideBin(process.argv))
  .usage('$0 command')
  .scriptName('avo')
  .version(pkg.version)
  .option('v', {
    alias: 'verbose',
    default: false,
    describe: 'make output more verbose',
    type: 'boolean',
  })
  .option('f', {
    alias: 'force',
    describe: 'Proceed with merge when incoming branch is open',
    default: false,
    type: 'boolean',
  })
  .command({
    command: 'track-install',
    desc: false,
    handler: () => {
      Avo.cliInstalled({
        userId_: installIdOrUserId(),
        cliInvokedByCi: invokedByCi(),
      });
    },
  })
  .command({
    command: 'init',
    desc: 'Initialize an Avo workspace in the current folder',
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipInit: true })
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
            });
            report.info(
              `Avo is already initialized for workspace ${cyan(
                json.schema.name,
              )} (${file('avo.json')} exists)`,
            );
          } else {
            Avo.cliInvoked({
              schemaId: 'N/A',
              schemaName: 'N/A',
              branchId: 'N/A',
              branchName: 'N/A',
              userId_: installIdOrUserId(),
              cliAction: Avo.CliAction.INIT,
              cliInvokedByCi: invokedByCi(),
            });
            return requireAuth(argv, () => init()
              .then(writeAvoJson)
              .then(() => {
                report.info(
                  "Run 'avo pull' to pull analytics wrappers from Avo",
                );
              }));
          }
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
          });
        });
    },
  })
  .command({
    command: 'pull [source]',
    desc: 'Pull analytics wrappers from Avo workspace',
    builder: (yargs) => yargs.option('branch', {
      describe: 'Name of Avo branch to pull from',
      type: 'string',
    }),
    handler: (argv) => {
      loadAvoJsonOrInit({ argv })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.PULL,
            cliInvokedByCi: invokedByCi(),
          });
          requireAuth(argv, () => {
            if (argv.branch && json.branch.name !== argv.branch) {
              return checkout(argv.branch, json)
                .then((json) => getSource(argv, json))
                .then(([source, json]) => pull(source, json));
            }
            report.info(`Pulling from branch '${json.branch.name}'`);
            return getSource(argv, json).then(([source, json]) => pull(source, json));
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
          });
          throw error;
        });
    },
  })
  .command({
    command: 'checkout [branch]',
    aliases: ['branch'],
    desc: 'Switch branches',
    handler: (argv) => loadAvoJsonOrInit({ argv })
      .then((json) => {
        Avo.cliInvoked({
          schemaId: json.schema.id,
          schemaName: json.schema.name,
          branchId: json.branch.id,
          branchName: json.branch.name,
          userId_: installIdOrUserId(),
          cliAction: Avo.CliAction.CHECKOUT,
          cliInvokedByCi: invokedByCi(),
        });
        report.info(`Currently on branch '${json.branch.name}'`);
        requireAuth(argv, () => checkout(argv.branch, json).then(writeAvoJson));
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
            loadAvoJsonOrInit({ argv })
              .then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi(),
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
                });
                throw error;
              });
          },
        })
        .command({
          command: 'add [source]',
          desc: 'Add a source to this project',
          handler: (argv) => {
            loadAvoJsonOrInit({ argv })
              .then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi(),
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
            loadAvoJsonOrInit({ argv })
              .then((json) => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  schemaName: json.schema.name,
                  branchId: json.branch.id,
                  branchName: json.branch.name,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi(),
                });

                if (!json.sources || !json.sources.length) {
                  report.warn(
                    `No sources defined in ${file('avo.json')}. Run ${cmd(
                      'avo source add',
                    )} to add sources`,
                  );
                  return;
                }

                const getSource = () => {
                  if (argv.source) {
                    return Promise.resolve(
                      _.find(json.sources, (source) => matchesSource(source, argv.source)),
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
                getSource(argv, json).then((targetSource) => {
                  if (!targetSource) {
                    report.error(`Source ${argv.source} not found in project.`);
                    return;
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
                        const sources = _.filter(
                          json.sources || [],
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
      loadAvoJsonOrInit({ argv })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.STATUS,
            cliInvokedByCi: invokedByCi(),
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
          });
          throw error;
        });
    },
  })

  .command({
    command: 'merge main',
    aliases: ['merge master'],
    desc: 'Pull the Avo main branch into your current branch',
    handler: (argv) => {
      loadAvoJsonOrInit({ argv, skipPullMaster: true })
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
          });
          throw error;
        });
    },
  })
  .command({
    command: 'conflict',
    aliases: ['resolve', 'conflicts'],
    desc: 'Resolve git conflicts in Avo files',
    handler: (argv) => pify(fs.readFile)('avo.json', 'utf8')
      .then((file) => {
        if (hasMergeConflicts(file)) {
          return requireAuth(argv, () => resolveAvoJsonConflicts(file, {
            argv,
          }).then((json) => {
            Avo.cliInvoked({
              schemaId: json.schema.id,
              schemaName: json.schema.name,
              branchId: json.branch.id,
              branchName: json.branch.name,
              userId_: installIdOrUserId(),
              cliAction: Avo.CliAction.CONFLICT,
              cliInvokedByCi: invokedByCi(),
            });
            pull(null, json);
          }));
        }
        report.info(
          "No git conflicts found in avo.json. Run 'avo pull' to resolve git conflicts in other Avo files.",
        );
        const json = JSON.parse(file);
        Avo.cliInvoked({
          schemaId: json.schema.id,
          schemaName: json.schema.name,
          branchId: json.branch.id,
          branchName: json.branch.name,
          userId_: installIdOrUserId(),
          cliAction: Avo.CliAction.CONFLICT,
          cliInvokedByCi: invokedByCi(),
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
        });
        throw error;
      }),
  })
  .command({
    command: 'edit',
    desc: 'Open the Avo workspace in your browser',
    handler: (argv) => {
      loadAvoJsonOrInit({ argv })
        .then((json) => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            schemaName: json.schema.name,
            branchId: json.branch.id,
            branchName: json.branch.name,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.EDIT,
            cliInvokedByCi: invokedByCi(),
          });

          const { schema } = json;
          const url = `https://www.avo.app/schemas/${schema.id}`;
          report.info(
            `Opening ${cyan(schema.name)} workspace in Avo: ${link(url)}`,
          );
          opn(url, { wait: false });
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
          .then((result) => {
            conf.set('user', result.user);
            conf.set('tokens', result.tokens);

            Avo.signedIn({
              userId_: result.user.user_id,
              email: result.user.email,
              cliInvokedByCi: invokedByCi(),
            });

            report.success(`Logged in as ${email(result.user.email)}`);
          })
          .catch(() => {
            Avo.signInFailed({
              userId_: conf.get('avo_install_id'),
              emailInput: '', // XXX this is not passed back here
              signInError: Avo.SignInError.UNKNOWN,
              cliInvokedByCi: invokedByCi(),
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
        const currentToken = _.get(tokens, 'refreshToken');
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
          report.log('No need to logout, you\'re not logged in');
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
          });
          command();
        });
    },
  })

  .demandCommand(1, 'must provide a valid command')
  .recommendCommands()
  .help().argv;

/// //////////////////////////////////////////////////////////////////////
// AUTH

function _haveValidAccessToken(refreshToken) {
  if (_.isEmpty(lastAccessToken)) {
    const tokens = conf.get('tokens');
    if (refreshToken === _.get(tokens, 'refreshToken')) {
      lastAccessToken = tokens;
    }
  }

  return (
    _.has(lastAccessToken, 'idToken')
    && lastAccessToken.refreshToken === refreshToken
    && _.has(lastAccessToken, 'expiresAt')
    && lastAccessToken.expiresAt > Date.now() + FIFTEEN_MINUTES_IN_MS
  );
}

function _getLoginUrl(callbackUrl) {
  return (
    `${api.authOrigin
    }/auth/cli?${
      _.map(
        {
          state: nonce,
          redirect_uri: callbackUrl,
        },
        (v, k) => `${k}=${encodeURIComponent(v)}`,
      ).join('&')}`
  );
}

function _loginWithLocalhost(port) {
  return new Promise((resolve, reject) => {
    const callbackUrl = _getCallbackUrl(port);
    const authUrl = _getLoginUrl(callbackUrl);

    var server = http.createServer((req, res) => {
      let tokens;
      const query = _.get(url.parse(req.url, true), 'query', {});

      if (query.state === nonce && _.isString(query.code)) {
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
            server.shutdown();
            return resolve({
              user: jwt.decode(tokens.idToken),
              tokens,
            });
          })
          .catch(() => _respondWithRedirect(
            req,
            res,
            `${api.authOrigin}/auth/cli/error`,
          ));
      }
      _respondWithRedirect(req, res, `${api.authOrigin}/auth/cli/error`);
    });

    server = httpShutdown(server);

    server.listen(port, () => {
      report.info(`Visit this URL on any device to login: ${link(authUrl)}`);
      wait('Waiting for authentication...');

      opn(authUrl, { wait: false });
    });

    server.on('error', () => {
      _loginWithoutLocalhost().then(resolve, reject);
    });
  });
}

function _loginWithoutLocalhost() {
  const callbackUrl = _getCallbackUrl();
  const authUrl = _getLoginUrl(callbackUrl);

  report.info(`Visit this URL on any device to login: ${url(authUrl)}`);

  opn(authUrl, { wait: false });
}

function login() {
  return _getPort().then(_loginWithLocalhost, _loginWithoutLocalhost);
}

function _respondWithRedirect(req, res, url) {
  return new Promise((resolve, reject) => {
    res.writeHead(302, {
      Location: url,
    });
    res.end();
    req.socket.destroy();
    return resolve();
  });
}

function _getTokensFromAuthorizationCode(code, callbackUrl) {
  return api
    .request('POST', '/auth/token', {
      origin: api.apiOrigin,
      json: {
        token: code,
        redirect_uri: callbackUrl,
      },
    })
    .then(
      (data) => {
        if (!data.idToken && !data.refreshToken) {
          throw INVALID_CREDENTIAL_ERROR;
        }
        lastAccessToken = _.assign(
          {
            expiresAt: Date.now() + data.expiresIn * 1000,
          },
          data,
        );
        return lastAccessToken;
      },
      () => {
        throw INVALID_CREDENTIAL_ERROR;
      },
    );
}

function _getCallbackUrl(port) {
  if (_.isUndefined(port)) {
    return 'urn:ietf:wg:oauth:2.0:oob';
  }
  return `http://localhost:${port}`;
}

function logout(refreshToken) {
  if (lastAccessToken.refreshToken === refreshToken) {
    lastAccessToken = {};
  }
  const tokens = conf.get('tokens');
  const currentToken = _.get(tokens, 'refreshToken');
  if (refreshToken === currentToken) {
    conf.delete('user');
    conf.delete('tokens');
  }
}

function requireAuth(argv, cb) {
  const tokens = conf.get('tokens');
  const user = conf.get('user');

  const tokenOpt = argv.token || process.env.AVO_TOKEN;

  if (tokenOpt) {
    api.setRefreshToken(tokenOpt);
    return cb();
  }

  if (!user || !tokens) {
    report.error(`Command requires authentication. Run ${cmd('avo login')}`);
    process.exit(1);
    return;
  }

  argv.user = user;
  argv.tokens = tokens;
  api.setRefreshToken(tokens.refreshToken);
  return cb();
}

/// ///////////////// ////////
// catch unhandled promises

process.on('unhandledRejection', (err) => {
  cancelWait();

  if (!(err instanceof Error) && !(err instanceof AvoError)) {
    err = new AvoError(`Promise rejected with value: ${util.inspect(err)}`);
  }
  report.error(err.message);
  // console.error(err.stack);

  process.exit(1);
});
