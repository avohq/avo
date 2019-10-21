#!/usr/bin/env node
const _ = require('lodash');
const {cyan, gray, red, bold, underline} = require('chalk');
const dateFns = require('date-fns');
const fs = require('fs');
const http = require('http');
const inquirer = require('inquirer');
const jwt = require('jsonwebtoken');
const loadJsonFile = require('load-json-file');
const logSymbols = require('log-symbols');
const opn = require('opn');
const ora = require('ora');
const path = require('path');
const pify = require('pify');
const portfinder = require('portfinder');
const querystring = require('querystring');
const request = require('request');
const report = require('yurnalist');
const semver = require('semver');
const updateNotifier = require('update-notifier');
const url = require('url');
const util = require('util');
const uuidv4 = require('uuid/v4');
const walk = require('ignore-walk');
const writeFile = require('write');
const writeJsonFile = require('write-json-file');
const Configstore = require('configstore');
const Minimatch = require('minimatch').Minimatch;

const pkg = require('./package.json');
const Avo = require('./Avo.js');

const customAnalyticsDestination = {
  make: function make(production) {
    this.production = production;
  },

  logEvent: function logEvent(userId, eventName, eventProperties) {
    api
      .request('POST', '/c/v1/track', {
        origin: api.apiOrigin,
        data: {
          userId: userId,
          eventName: eventName,
          eventProperties: eventProperties
        }
      })
      .catch(function() {
        // don't crash on tracking errors
      });
  }
};

// setup Avo analytics
Avo.initAvo(
  {env: 'prod'},
  {client: Avo.Client.CLI, version: pkg.version},
  {},
  customAnalyticsDestination
);

// register inquirer-file-path
inquirer.registerPrompt('fuzzypath', require('inquirer-fuzzy-path'));

updateNotifier({pkg: pkg}).notify();

const conf = new Configstore(pkg.name);

if (!conf.has('avo_install_id')) {
  conf.set('avo_install_id', uuidv4());
}

const FIFTEEN_MINUTES_IN_MS = 15 * 60 * 1000;

// to cancel spinners globally
let _cancel = null;

var nonce = _.random(1, 2 << 29).toString();

portfinder.basePort = 9005;
var _getPort = portfinder.getPortPromise;

function AvoError(message, options) {
  options = options || {};

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

var INVALID_CREDENTIAL_ERROR = new AvoError(
  `Authentication Error: Your credentials are no longer valid. Please run ${cmd(
    'avo logout; avo login'
  )}`,
  {exit: 1}
);

// in-memory cache, so we have it for successive calls
var lastAccessToken = {};
var accessToken;
var refreshToken;
var commandScopes;

/////////////////////////////////////////////////////////////////////////
// REQUEST HANDLING

function _request(options, logOptions) {
  logOptions = logOptions || {};

  if (options.qs && !logOptions.skipQueryParams) {
    qsLog = JSON.stringify(options.qs);
  }

  if (!logOptions.skipRequestBody) {
    bodyLog = options.body || options.form || '';
  }

  // logger.debug(">>> HTTP REQUEST", options.method, options.url, qsLog, "\n", bodyLog);

  return new Promise(function(resolve, reject) {
    var req = request(options, function(err, response, body) {
      if (err) {
        return reject(
          new AvoError('Server Error. ' + err.message, {
            original: err,
            exit: 2
          })
        );
      }

      if (response.statusCode >= 400 && !logOptions.skipResponseBody) {
        if (!options.resolveOnHTTPError) {
          return reject(responseToError(response, body, options));
        }
      }
      return resolve({
        status: response.statusCode,
        response: response,
        body: body
      });
    });

    if (_.size(options.files) > 0) {
      var form = req.form();
      _.forEach(options.files, function(details, param) {
        form.append(param, details.stream, {
          knownLength: details.knownLength,
          filename: details.filename,
          contentType: details.contentType
        });
      });
    }
  });
}

var _appendQueryData = function(path, data) {
  if (data && _.size(data) > 0) {
    path += _.includes(path, '?') ? '&' : '?';
    path += querystring.stringify(data);
  }
  return path;
};

var api = {
  authOrigin: 'https://www.avo.app',

  apiOrigin: 'https://api.avo.app',

  setRefreshToken: function(token) {
    refreshToken = token;
  },
  setAccessToken: function(token) {
    accessToken = token;
  },
  getAccessToken: function() {
    return accessToken
      ? Promise.resolve({idToken: accessToken})
      : getAccessToken(refreshToken, commandScopes);
  },
  addRequestHeaders: function(reqOptions) {
    // Runtime fetch of Auth singleton to prevent circular module dependencies
    _.set(reqOptions, ['headers', 'User-Agent'], 'AvoCLI/' + pkg.version);
    _.set(reqOptions, ['headers', 'X-Client-Version'], 'AvoCLI/' + pkg.version);
    return api.getAccessToken().then(function(result) {
      _.set(reqOptions, 'headers.authorization', 'Bearer ' + result.idToken);
      return reqOptions;
    });
  },
  request: function(method, resource, options) {
    options = _.extend(
      {
        data: {},
        origin: undefined, // origin must be set
        resolveOnHTTPError: false, // by default, status codes >= 400 leads to reject
        json: true,
        gzip: true
      },
      options
    );

    var validMethods = ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'];

    if (validMethods.indexOf(method) < 0) {
      method = 'GET';
    }

    var reqOptions = {
      method: method
    };

    if (options.query) {
      resource = _appendQueryData(resource, options.query);
    }

    if (method === 'GET') {
      resource = _appendQueryData(resource, options.data);
    } else {
      if (_.size(options.data) > 0) {
        reqOptions.body = options.data;
      } else if (_.size(options.form) > 0) {
        reqOptions.form = options.form;
      }
    }

    reqOptions.url = options.origin + resource;
    reqOptions.files = options.files;
    reqOptions.resolveOnHTTPError = options.resolveOnHTTPError;
    reqOptions.json = options.json;
    reqOptions.gzip = options.gzip;
    reqOptions.qs = options.qs;
    reqOptions.headers = options.headers;
    reqOptions.timeout = options.timeout;

    var requestFunction = function() {
      return _request(reqOptions, options.logOptions);
    };
    if (options.auth === true) {
      requestFunction = function() {
        return api
          .addRequestHeaders(reqOptions)
          .then(function(reqOptionsWithToken) {
            return _request(reqOptionsWithToken, options.logOptions);
          });
      };
    }

    return requestFunction().catch(function(err) {
      if (
        options.retryCodes &&
        _.includes(
          options.retryCodes,
          _.get(err, 'context.response.statusCode')
        )
      ) {
        return new Promise(function(resolve) {
          setTimeout(resolve, 1000);
        }).then(requestFunction);
      }
      return Promise.reject(err);
    });
  }
};

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
    str.includes(MERGE_CONFLICT_START) &&
    str.includes(MERGE_CONFLICT_SEP) &&
    str.includes(MERGE_CONFLICT_END)
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
    throw new AvoError(`Your avo CLI is outdated, please update`);
  }

  if (isLegacyAvoJson(json)) {
    return init();
  }

  // augment the latest major version into avo.json
  json.avo = Object.assign({}, json.avo || {}, {
    version: semver.major(pkg.version)
  });

  return json;
}

const BRANCH_UP_TO_DATE = 'branch-up-to-date';
const BRANCH_NOT_UP_TO_DATE = 'branch-not-up-to-date';

function getMasterStatus(json) {
  if (json.branch.id == 'master') {
    return Promise.resolve(BRANCH_UP_TO_DATE);
  } else {
    return api
      .request('POST', '/c/v1/master', {
        origin: api.apiOrigin,
        auth: true,
        data: {
          schemaId: json.schema.id,
          branchId: json.branch.id
        }
      })
      .then(res => {
        return res.body.pullRequired
          ? BRANCH_NOT_UP_TO_DATE
          : BRANCH_UP_TO_DATE;
      });
  }
}

function pullMaster(json) {
  if (json.branch.name == 'master') {
    report.info('Your current branch is master');
    return Promise.resolve(json);
  } else {
    wait('Pulling master into branch');
    return api
      .request('POST', '/c/v1/master/pull', {
        origin: api.apiOrigin,
        auth: true,
        data: {
          schemaId: json.schema.id,
          branchId: json.branch.id
        }
      })
      .then(() => {
        cancelWait();
        report.success('Branch is up to date with master');
        return json;
      });
  }
}

function promptPullMaster(json) {
  wait('Check if branch is up to date with master');
  return getMasterStatus(json)
    .then(branchStatus => {
      cancelWait();
      if (branchStatus == BRANCH_UP_TO_DATE) {
        return Promise.resolve([branchStatus]);
      } else if (branchStatus == BRANCH_NOT_UP_TO_DATE) {
        return inquirer
          .prompt([
            {
              type: 'confirm',
              name: 'pull',
              default: true,
              message: `Your branch '${bold(
                json.branch.name
              )}' is not up to date with the Avo master branch. Would you like to pull master into your branch?`
            }
          ])
          .then(answer => Promise.resolve([branchStatus, answer]));
      }
    })
    .then(([branchStatus, answer]) => {
      if (branchStatus == BRANCH_UP_TO_DATE) {
        report.success('Branch is up to date with master');
        return Promise.resolve(json);
      } else if (answer.pull) {
        return pullMaster(json);
      } else {
        report.info(`Did not pull master into branch`);
        return Promise.resolve(json);
      }
    });
}

function resolveAvoJsonConflicts(file, {argv, skipPullMaster}) {
  report.info('Resolving Avo merge conflicts');
  let files = extractConflictingFiles(file);
  const head = JSON.parse(files[0]);
  const incoming = JSON.parse(files[1]);

  if (
    head.avo.version != incoming.avo.version ||
    head.schema.id != incoming.schema.id
  ) {
    throw new Error(
      "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in avo.json before running 'avo pull' again."
    );
  }

  if (
    !_.isEqual(head.sources.map(s => s.id), incoming.sources.map(s => s.id))
  ) {
    throw new Error(
      "Could not automatically resolve merge conflicts in avo.json. Resolve merge conflicts in sources list in avo.json before running 'avo pull' again."
    );
  }

  const nextAvoJson = {
    avo: head.avo,
    schema: head.schema,
    branch: head.branch,
    sources: head.sources
  };
  return requireAuth(argv, () => {
    return fetchBranches(nextAvoJson).then(branches => {
      const isHeadBranchOpen = branches.find(branch => {
        return branch.id == nextAvoJson.branch.id;
      });

      const isIncomingBranchOpen = branches.find(branch => {
        return branch.id == incoming.branch.id;
      });

      function switchBranchIfRequired(json) {
        if (isHeadBranchOpen) {
          return Promise.resolve(json);
        } else {
          report.info(
            `Your current branch '${json.branch.name}' has been closed or merged. Go to another branch:`
          );
          return checkout(null, json);
        }
      }

      return switchBranchIfRequired(nextAvoJson)
        .then(json => {
          if (
            head.branch.id == incoming.branch.id ||
            incoming.branch.id == 'master'
          ) {
            return Promise.resolve([true, json]);
          } else {
            return Promise.resolve([false, json]);
          }
        })
        .then(([isDone, json]) => {
          if (!isDone && isIncomingBranchOpen && argv.force) {
            report.warn(
              `Incoming branch, ${
                incoming.branch.name
              }, has not been merged to Avo master. To review and merge go to: ${link(
                `https://www.avo.app/schemas/${nextAvoJson.schema.id}/branches/${incoming.branch.id}/diff`
              )}`
            );
            return Promise.resolve(json);
          } else if (!isDone && isIncomingBranchOpen) {
            throw new Error(
              `Incoming branch, ${
                incoming.branch.name
              }, has not been merged to Avo master.\n\nTo review and merge go to:\n${link(
                `https://www.avo.app/schemas/${nextAvoJson.schema.id}/branches/${incoming.branch.id}/diff`
              )}\n\nOnce merged, run 'avo pull'. To skip this check use the --force flag.`
            );
          } else {
            return Promise.resolve(json);
          }
        })
        .then(json => {
          if (skipPullMaster) {
            return Promise.resolve(json);
          } else {
            return promptPullMaster(json);
          }
        })
        .then(json => {
          report.success('Successfully resolved Avo merge conflicts');
          return validateAvoJson(json);
        });
    });
  });
}

function loadAvoJson() {
  return loadJsonFile('avo.json')
    .then(validateAvoJson)
    .catch(err => {
      if (err.code === 'ENOENT') {
        throw new AvoError(
          `File ${file('avo.json')} does not exist. Run ${cmd('avo init')}`
        );
      } else {
        throw err;
      }
    });
}

function loadAvoJsonOrInit({argv, skipPullMaster, skipInit}) {
  return pify(fs.readFile)('avo.json', 'utf8')
    .then(file => {
      if (hasMergeConflicts(file)) {
        return resolveAvoJsonConflicts(file, {
          argv,
          skipPullMaster
        });
      } else {
        return Promise.resolve(JSON.parse(file));
      }
    })
    .then(validateAvoJson)
    .catch(error => {
      if (error.code === 'ENOENT' && skipInit) {
        return;
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
    indent: 2
  }).then(() => json);
}

function init() {
  let makeAvoJson = schema => {
    report.success(`Initialized for workspace ${cyan(schema.name)}`);

    return {
      avo: {
        version: semver.major(pkg.version)
      },
      schema: {
        id: schema.id,
        name: schema.name
      },
      branch: {
        id: 'master',
        name: 'master'
      }
    };
  };
  wait('Initializing');
  return api
    .request('GET', '/c/v1/workspaces', {
      origin: api.apiOrigin,
      auth: true
    })
    .then(res => {
      cancelWait();
      let result = res.body;
      let schemas = _.orderBy(result.workspaces, 'lastUsedAt', 'desc');
      if (schemas.length > 1) {
        let choices = schemas.map(schema => ({
          value: schema,
          name: schema.name
        }));
        return inquirer
          .prompt([
            {
              type: 'list',
              name: 'schema',
              message: 'Select a workspace to initialize',
              choices: choices
            }
          ])
          .then(answer => {
            return makeAvoJson(answer.schema);
          });
      } else if (schemas.length === 0) {
        throw new AvoError(
          `No workspaces to initialize. Go to ${link(
            'wwww.avo.app'
          )} to create one`
        );
      } else {
        let schema = schemas[0];
        return makeAvoJson(schema);
      }
    });
}

function codegen(json, result) {
  let schema = result.schema;
  let targets = result.sources;
  let newJson = Object.assign({}, _.cloneDeep(json), {schema: schema});

  newJson.sources = newJson.sources.map(source => {
    let target = _.find(targets, target => target.id === source.id);
    if (target) {
      return Object.assign({}, source, {
        actionId: target.actionId,
        name: target.name,
        id: target.id,
        path: source.path,
        branchId: target.branchId,
        updatedAt: target.updatedAt
      });
    } else {
      return source;
    }
  });

  let sourceTasks = targets.map(target => {
    return Promise.all(
      target.code.map(code => writeFile.promise(code.path, code.content))
    );
  });

  let avoJsonTask = writeAvoJson(newJson);

  Promise.all(_.concat([avoJsonTask], sourceTasks)).then(() => {
    report.success(
      `Analytics ${
        targets.length > 1 ? 'wrappers' : 'wrapper'
      } successfully updated`
    );
    targets.forEach(target => {
      let source = _.find(newJson.sources, source => source.id === target.id);
      report.tree('sources', [
        {
          name: source.name,
          children: target.code.map(code => {
            return {name: code.path};
          })
        }
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
      data: {
        schemaId: json.schema.id,
        branchId: json.branch.id
      }
    })
    .then(res => {
      cancelWait();
      let result = res.body;
      let existingSources = json.sources || [];
      let sources = _.sortBy(
        _.filter(
          result.sources,
          source =>
            _.find(
              existingSources,
              existingSource => source.id === existingSource.id
            ) === undefined
        ),
        'name'
      );

      let prompts = [
        {
          type: 'fuzzypath',
          name: 'folder',
          excludePath: path =>
            path.startsWith('node_modules') || path.startsWith('.git'),
          itemType: 'directory',
          rootPath: '',
          message: 'Select a folder to save the analytics wrapper in',
          default: '',
          suggestOnly: false
        }
      ];

      if (!sourceToAdd) {
        let choices = sources.map(source => {
          return {value: source, name: source.name};
        });

        prompts.unshift({
          type: 'list',
          name: 'source',
          message: 'Select a source to setup',
          choices: choices,
          pageSize: 15
        });
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename fer the analytics wrapper',
          default: function(answers) {
            return answers.source.filenameHint;
          }
        });
      } else {
        let source = _.find(sources, source =>
          matchesSource(source, sourceToAdd)
        );
        if (!source) {
          throw new AvoError(`Source ${sourceToAdd} does not exist`);
        }
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename fer the library',
          default: function(answers) {
            return source.filenameHint;
          }
        });
      }

      return inquirer.prompt(prompts).then(answer => {
        let relativePath = path.relative(
          process.cwd(),
          path.join(path.resolve(answer.folder), answer.filename)
        );
        let source;
        if (sourceToAdd) {
          source = _.find(sources, source =>
            matchesSource(source, sourceToAdd)
          );
          source = {id: source.id, name: source.name, path: relativePath};
        } else {
          source = {
            id: answer.source.id,
            name: answer.source.name,
            path: relativePath
          };
        }
        sources = _.concat(json.sources || [], [source]);
        let newJson = Object.assign({}, json, {sources: sources});
        report.info(`Added source ${source.name} to the project`);
        report.info(
          `Run 'avo pull "${source.name}"' to pull latest analytics wrapper for source`
        );
        return newJson;
      });
    });
}

function fetchBranches(json) {
  const schemaId = json.schema.id;
  wait('Fetching open branches');
  const payload = {
    origin: api.apiOrigin,
    auth: true,
    data: {
      schemaId: json.schema.id
    }
  };
  return api.request('POST', '/c/v1/branches', payload).then(res => {
    cancelWait();
    let result = res.body;
    let branches = _.sortBy(result.branches, 'name');
    return branches;
  });
}

function checkout(branchToCheckout, json) {
  return fetchBranches(json).then(branches => {
    if (!branchToCheckout) {
      let choices = branches.map(branch => {
        return {value: branch, name: branch.name};
      });
      let currentBranch = _.find(
        branches,
        branch => branch.id == json.branch.id
      );
      return inquirer
        .prompt([
          {
            type: 'list',
            name: 'branch',
            message: 'Select a branch',
            default:
              currentBranch ||
              _.find(branches, branch => branch.id == 'master'),
            choices: choices,
            pageSize: 15
          }
        ])
        .then(answer => {
          if (answer.branch === currentBranch) {
            report.info(`Already on '${currentBranch.name}'`);
            return json;
          } else {
            let branch = answer.branch;
            json = Object.assign({}, json, {
              branch: {
                id: branch.id,
                name: branch.name
              }
            });
            report.success(`Switched to branch '${branch.name}'`);
            return json;
          }
        });
    } else {
      if (branchToCheckout == json.branch.name) {
        // XXX should check here if json.branch.id === branch.id from server
        // if not, it indicates branch delete, same branch re-created and client is out of sync
        report.info(`Already on '${branchToCheckout}'`);
        return json;
      }
      let branch = _.find(branches, branch => branch.name == branchToCheckout);
      if (!branch) {
        report.error(
          `Branch '${branchToCheckout}' does not exist. Run ${cmd(
            'avo checkout'
          )} to list available branches`
        );
      } else {
        json = Object.assign({}, json, {
          branch: {
            id: branch.id,
            name: branch.name
          }
        });
        report.success(`Switched to branch '${branch.name}'`);
        return json;
      }
    }
  });
}

function matchesSource(source, filter) {
  return source.name.toLowerCase() === filter.toLowerCase();
}

function pull(sourceFilter, json) {
  let sources = sourceFilter
    ? [_.find(json.sources, source => matchesSource(source, sourceFilter))]
    : json.sources;
  let sourceNames = _.map(sources, source => source.name);
  wait(`Pulling ${sourceNames.join(', ')}`);

  return getMasterStatus(json)
    .then(status => {
      if (status == BRANCH_NOT_UP_TO_DATE) {
        report.warn(
          `Your branch '${json.branch.name}' is not up to date with Avo master. To merge latest Avo master into branch run 'avo merge master'.`
        );
      }
      return Promise.resolve();
    })
    .then(() => {
      return api.request('POST', '/c/v1/pull', {
        origin: api.apiOrigin,
        auth: true,
        data: {
          schemaId: json.schema.id,
          branchId: json.branch.id,
          sources: _.map(sources, source => {
            return {id: source.id, path: source.path};
          })
        }
      });
    })
    .then(res => {
      cancelWait();
      let result = res.body;
      if (result.ok) {
        codegen(json, result);
      } else {
        report.error(
          `Branch ${result.branchName} was ${
            result.reason
          } ${dateFns.distanceInWords(
            new Date(result.closedAt),
            new Date()
          )} ago. Pick another branch.`
        );
        checkout(null, json).then(json => {
          return pull(sourceFilter, json);
        });
      }
    });
}

function installIdOrUserId() {
  let installId = conf.get('avo_install_id');
  let user = conf.get('user');
  if (user && user.user_id) {
    return user.user_id;
  } else {
    return installId;
  }
}

function invokedByCi() {
  return process.env.CI !== undefined;
}

function findMatches(data, regex) {
  let isGlobal = regex.global;
  let lines = data.split('\n');
  let fileMatches = [];
  let lastIndex = 0;

  for (let index = 0; index < lines.length; index++) {
    let lineContents = lines[index];
    let line = lastIndex + index;
    let match;

    while (true) {
      match = regex.exec(lineContents);
      if (!match) break;

      let start = match.index;
      let end = match.index + match[0].length;

      fileMatches.push({
        line,
        start,
        end,
        lineContents
      });

      if (!isGlobal) break;
    }
  }

  lastIndex += lines.length;

  return fileMatches;
}

function getEventMap(data) {
  let searchFor = 'AVOEVENTMAP:';
  let lines = data.split('\n').filter(line => line.indexOf(searchFor) > -1);
  if (lines.length === 1) {
    let line = lines[0].substring(
      lines[0].indexOf(searchFor) + searchFor.length
    );
    line = line.substring(line.indexOf('['), line.indexOf(']') + 1);
    let eventMap = JSON.parse(line);
    return eventMap;
  } else {
    return null;
  }
}

function getModuleMap(data) {
  let searchFor = 'AVOMODULEMAP:';
  let lines = data.split('\n').filter(line => line.indexOf(searchFor) > -1);
  if (lines.length === 1) {
    let line = lines[0].substring(
      lines[0].indexOf(searchFor) + searchFor.length
    );
    line = line.substring(line.indexOf('"'), line.lastIndexOf('"') + 1);
    let moduleMap = JSON.parse(line);
    return moduleMap;
  } else {
    return null;
  }
}

function getSource(argv, json) {
  if (!json.sources || !json.sources.length) {
    report.info(`No sources configured.`);
    return requireAuth(argv, () => {
      if (argv.source) {
        report.info(`Setting up source "${argv.source}"`);
      }
      return selectSource(argv.source, json).then(json => [argv.source, json]);
    });
  } else if (
    argv.source &&
    !_.find(json.sources, source => matchesSource(source, argv.source))
  ) {
    report.error(`Source ${argv.source} not found`);
    return requireAuth(argv, () =>
      selectSource(argv.source, json).then(json => [argv.source, json])
    );
  } else {
    return Promise.resolve([argv.source, json]);
  }
}

function status(source, json, argv) {
  let sources = source
    ? _.filter(json.sources, source => matchesSource(source, source))
    : json.sources;

  sources = sources.filter(source => source.analysis !== false);
  let fileCache = walk({
    ignoreFiles: ['.gitignore'],
    follow: false
  }).then(results => {
    results = results.filter(path => !path.startsWith('.git'));
    return Promise.all(
      results.map(path => {
        return pify(fs.lstat)(path).then(stats => {
          if (stats.isSymbolicLink()) {
            return [];
          } else {
            return pify(fs.readFile)(path, 'utf8').then(data => {
              return [path, data];
            });
          }
        });
      })
    ).then(cachePairs => _.fromPairs(cachePairs));
  });

  fileCache
    .then(cache => {
      sources = Promise.all(
        sources.map(source => {
          return pify(fs.readFile)(source.path, 'utf8').then(data => {
            let eventMap = getEventMap(data);
            if (eventMap !== null) {
              let moduleMap = getModuleMap(data);
              let sourcePath = path.parse(source.path);
              let moduleName = _.get(
                source,
                'analysis.module',
                moduleMap || sourcePath.name || 'Avo'
              );

              let globs = [
                new Minimatch(
                  _.get(source, 'analysis.glob', '**/*' + sourcePath.ext),
                  {}
                ),
                new Minimatch('!' + source.path, {})
              ];

              let lookup = _.pickBy(cache, (value, path) =>
                _.every(globs, mm => mm.match(path))
              );

              return Promise.all(
                eventMap.map(eventName => {
                  let re = new RegExp(moduleName + '\\.' + eventName);
                  let results = _.flatMap(lookup, (data, path) => {
                    let results = findMatches(data, re);
                    return results.length ? [[path, results]] : [];
                  });
                  return [eventName, _.fromPairs(results)];
                })
              ).then(results => {
                return Object.assign({}, source, {
                  results: _.fromPairs(results)
                });
              });
            } else {
              return source;
            }
          });
        })
      );

      return sources.then(sources => {
        if (argv.verbose) {
          report.tree(
            'sources',
            sources.map(source => {
              return {
                name: source.name + ' (' + source.path + ')',
                children:
                  _.size(source.results) > 1
                    ? _.map(source.results, (results, eventName) => {
                        return {
                          name: eventName,
                          children:
                            _.size(results) > 0
                              ? _.map(results, (result, matchFile) => {
                                  return {
                                    name:
                                      'used in ' +
                                      matchFile +
                                      ': ' +
                                      result.length +
                                      (result.length === 1 ? ' time' : ' times')
                                  };
                                })
                              : [
                                  {
                                    name: `${logSymbols.error} no usage found`
                                  }
                                ]
                        };
                      })
                    : [
                        {
                          name:
                            'no usage information found - please run avo pull'
                        }
                      ]
              };
            })
          );
        }

        let totalEvents = _.sumBy(sources, source => _.size(source.results));
        let missingEvents = _.sumBy(sources, source =>
          _.sum(
            _.map(source.results, (results, eventName) =>
              _.size(results) > 0 ? 0 : 1
            )
          )
        );
        if (missingEvents === 0) {
          report.info(`${totalEvents} events seen in code`);
        } else {
          report.info(
            `${totalEvents -
              missingEvents} of ${totalEvents} events seen in code`
          );
        }
        if (missingEvents > 0) {
          report.error(
            `${missingEvents} missing ${missingEvents > 1 ? 'events' : 'event'}`
          );
          report.tree(
            'missingEvents',
            sources.map(source => {
              return {
                name: source.name + ' (' + source.path + ')',
                children:
                  _.size(source.results) > 1
                    ? _.flatMap(source.results, (results, eventName) => {
                        return _.size(results) === 0
                          ? [
                              {
                                name: `${red(eventName)}: no usage found`
                              }
                            ]
                          : [];
                      })
                    : [
                        {
                          name:
                            'no usage information found - please run avo pull'
                        }
                      ]
              };
            })
          );
          process.exit(1);
        }
      });
    })
    .catch(error => {
      if (error.code == 'ENOENT') {
        report.error(
          "Avo file not found. Run 'avo pull' to pull latest Avo files."
        );
      } else {
        throw error;
      }
    });
}

require('yargs')
  .usage('$0 command')
  .scriptName('avo')
  .option('v', {
    alias: 'verbose',
    default: false,
    describe: 'make output more verbose',
    type: 'boolean'
  })
  .option('f', {
    alias: 'force',
    describe: 'Proceed with merge when incoming branch is open',
    default: false,
    type: 'boolean'
  })
  .command({
    command: 'track-install',
    desc: false,
    handler: () => {
      Avo.cliInstalled({
        userId_: installIdOrUserId(),
        cliInvokedByCi: invokedByCi()
      });
    }
  })
  .command({
    command: 'init',
    desc: 'Initialize an Avo workspace in the current folder',
    handler: argv => {
      loadAvoJsonOrInit({argv, skipInit: true})
        .then(json => {
          if (json) {
            Avo.cliInvoked({
              schemaId: json.schema.id,
              userId_: installIdOrUserId(),
              cliAction: Avo.CliAction.INIT,
              cliInvokedByCi: invokedByCi()
            });
            report.info(
              `Avo is already initialized for workspace ${cyan(
                json.schema.name
              )} (${file('avo.json')} exists)`
            );
          } else {
            Avo.cliInvoked({
              schemaId: 'N/A',
              userId_: installIdOrUserId(),
              cliAction: Avo.CliAction.INIT,
              cliInvokedByCi: invokedByCi()
            });
            return requireAuth(argv, () => {
              return init()
                .then(writeAvoJson)
                .then(() => {
                  report.info(
                    "Run 'avo pull' to pull analytics wrappers from Avo"
                  );
                });
            });
          }
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.INIT,
            cliInvokedByCi: invokedByCi()
          });
        });
    }
  })
  .command({
    command: 'pull [source]',
    desc: 'Pull analytics wrappers from Avo workspace',
    builder: yargs => {
      return yargs.option('branch', {
        describe: 'Name of Avo branch to pull from',
        type: 'string'
      });
    },
    handler: argv => {
      loadAvoJsonOrInit({argv})
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.PULL,
            cliInvokedByCi: invokedByCi()
          });
          requireAuth(argv, () => {
            if (argv.branch && json.branch.name !== argv.branch) {
              return checkout(argv.branch, json)
                .then(json => getSource(argv, json))
                .then(([source, json]) => pull(source, json));
            } else {
              report.info(`Pulling from branch '${json.branch.name}'`);
              return getSource(argv, json).then(([source, json]) => {
                return pull(source, json);
              });
            }
          });
        })
        .catch(error => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.PULL,
            cliInvokedByCi: invokedByCi()
          });
          throw error;
        });
    }
  })
  .command({
    command: 'checkout [branch]',
    aliases: ['branch'],
    desc: 'Switch branches',
    handler: argv => {
      return loadAvoJsonOrInit({argv})
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CHECKOUT,
            cliInvokedByCi: invokedByCi()
          });
          report.info(`Currently on branch '${json.branch.name}'`);
          requireAuth(argv, () => {
            return checkout(argv.branch, json).then(writeAvoJson);
          });
        })
        .catch(error => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CHECKOUT,
            cliInvokedByCi: invokedByCi()
          });
          throw error;
        });
    }
  })
  .command({
    command: 'source <command>',
    desc: 'Manage sources for the current project',
    builder: yargs => {
      yargs
        .command({
          command: '$0',
          desc: 'List sources in this project',
          handler: argv => {
            loadAvoJsonOrInit({argv})
              .then(json => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi()
                });

                if (!json.sources || !json.sources.length) {
                  report.info(
                    `No sources defined in ${file('avo.json')}. Run ${cmd(
                      'avo source add'
                    )} to add sources`
                  );
                  return;
                }

                report.info(`Sources in this project:`);
                report.tree(
                  'sources',
                  json.sources.map(source => {
                    return {
                      name: source.name,
                      children: [{name: source.path}]
                    };
                  })
                );
              })
              .catch(error => {
                Avo.cliInvoked({
                  schemaId: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi()
                });
                throw error;
              });
          }
        })
        .command({
          command: 'add [source]',
          desc: 'Add a source to this project',
          handler: argv => {
            loadAvoJsonOrInit({argv})
              .then(json => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi()
                });

                requireAuth(argv, () => {
                  selectSource(argv.source, json).then(writeAvoJson);
                });
              })
              .catch(error => {
                Avo.cliInvoked({
                  schemaId: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi()
                });
                throw error;
              });
          }
        })
        .command({
          command: 'remove [source]',
          aliases: ['rm'],
          desc: 'Remove a source from this project',
          handler: argv => {
            loadAvoJsonOrInit({argv})
              .then(json => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi()
                });

                if (!json.sources || !json.sources.length) {
                  report.warn(
                    `No sources defined in ${file('avo.json')}. Run ${cmd(
                      'avo source add'
                    )} to add sources`
                  );
                  return;
                }

                const getSource = () => {
                  if (argv.source) {
                    return Promise.resolve(
                      _.find(json.sources, source =>
                        matchesSource(source, argv.source)
                      )
                    );
                  } else {
                    let choices = json.sources.map(source => ({
                      value: source,
                      name: source.name
                    }));
                    return inquirer
                      .prompt({
                        type: 'list',
                        name: 'source',
                        message: 'Select a source to remove',
                        choices: choices,
                        pageSize: 15
                      })
                      .then(answer => answer.source);
                  }
                };
                getSource(argv, json).then(targetSource => {
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
                        message: `Are you sure you want to remove source ${targetSource.name} from project`
                      }
                    ])
                    .then(answer => {
                      if (answer.remove) {
                        let sources = _.filter(
                          json.sources || [],
                          source => source.id !== targetSource.id
                        );
                        let newJson = Object.assign({}, json, {
                          sources: sources
                        });
                        return writeAvoJson(newJson).then(() => {
                          // XXX ask to remove file as well?
                          report.info(
                            `Removed source ${targetSource.name} from project`
                          );
                        });
                      } else {
                        report.info(
                          `Did not remove source ${targetSource.name} from project`
                        );
                      }
                    });
                });
              })
              .catch(error => {
                Avo.cliInvoked({
                  schemaId: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi()
                });
                throw error;
              });
          }
        });
    }
  })
  .command({
    command: 'status [source]',
    desc: 'Show the status of the Avo implementation',
    handler: argv => {
      loadAvoJsonOrInit({argv})
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.STATUS,
            cliInvokedByCi: invokedByCi()
          });
          report.info(`Currently on branch '${json.branch.name}'`);
          return getSource(argv, json);
        })
        .then(([source, json]) => {
          return writeAvoJson(json).then(json => [source, json]);
        })
        .then(([source, json]) => {
          return status(source, json, argv);
        })
        .catch(error => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.STATUS,
            cliInvokedByCi: invokedByCi()
          });
          throw error;
        });
    }
  })

  .command({
    command: 'merge master',
    desc: 'Pull Avo master branch into your current branch',
    handler: argv => {
      loadAvoJsonOrInit({argv, skipPullMaster: true})
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.MERGE,
            cliInvokedByCi: invokedByCi()
          });

          return requireAuth(argv, () => {
            return pullMaster(json).then(writeAvoJson);
          });
        })
        .catch(error => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.MERGE,
            cliInvokedByCi: invokedByCi()
          });
          throw error;
        });
    }
  })
  .command({
    command: 'conflict',
    aliases: ['resolve', 'conflicts'],
    desc: 'Resolve git conflicts in Avo files',
    handler: argv => {
      return pify(fs.readFile)('avo.json', 'utf8')
        .then(file => {
          if (hasMergeConflicts(file)) {
            return requireAuth(argv, () => {
              return resolveAvoJsonConflicts(file, {
                argv
              }).then(json => {
                Avo.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: Avo.CliAction.CONFLICT,
                  cliInvokedByCi: invokedByCi()
                });
                pull(null, json);
              });
            });
          } else {
            report.info(
              "No git conflicts found in avo.json. Run 'avo pull' to resolve git conflicts in other Avo files."
            );
            const json = JSON.parse(file);
            Avo.cliInvoked({
              schemaId: json.schema.id,
              userId_: installIdOrUserId(),
              cliAction: Avo.CliAction.CONFLICT,
              cliInvokedByCi: invokedByCi()
            });
            return Promise.resolve(json);
          }
        })
        .catch(error => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.CONFLICT,
            cliInvokedByCi: invokedByCi()
          });
          throw error;
        });
    }
  })
  .command({
    command: 'edit',
    desc: 'Open the Avo workspace in your browser',
    handler: argv => {
      loadAvoJsonOrInit({argv})
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.EDIT,
            cliInvokedByCi: invokedByCi()
          });

          const schema = json.schema;
          const url = `https://www.avo.app/schemas/${schema.id}`;
          report.info(
            `Opening ${cyan(schema.name)} workspace in Avo: ${link(url)}`
          );
          opn(url, {wait: false});
        })
        .catch(error => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.EDIT,
            cliInvokedByCi: invokedByCi()
          });
          throw error;
        });
    }
  })
  .command({
    command: 'login',
    desc: 'Log into the Avo platform',
    handler: () => {
      let command = () => {
        let user = conf.get('user');
        if (user) {
          report.info(`Already logged in as ${email(user.email)}`);
          return;
        }
        login()
          .then(function(result) {
            conf.set('user', result.user);
            conf.set('tokens', result.tokens);

            Avo.signedIn({
              userId_: result.user.user_id,
              email: result.user.email,
              cliInvokedByCi: invokedByCi()
            });

            report.success(`Logged in as ${email(result.user.email)}`);
          })
          .catch(() => {
            Avo.signInFailed({
              userId_: conf.get('avo_install_id'),
              emailInput: '', // XXX this is not passed back here
              signInError: Avo.SignInError.UNKNOWN,
              cliInvokedByCi: invokedByCi()
            });
          });
      };

      loadAvoJson()
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGIN,
            cliInvokedByCi: invokedByCi()
          });
          command();
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGIN,
            cliInvokedByCi: invokedByCi()
          });
          command();
        });
    }
  })
  .command({
    command: 'logout',
    desc: 'Log out from the Avo platform',
    handler: () => {
      let command = () => {
        let user = conf.get('user');
        let tokens = conf.get('tokens');
        let currentToken = _.get(tokens, 'refreshToken');
        let token = currentToken;
        api.setRefreshToken(token);
        if (token) {
          logout(token);
        }
        if (token || user || tokens) {
          var msg = 'Logged out';
          if (token === currentToken) {
            if (user) {
              msg += ' from ' + bold(user.email);
            }
          } else {
            msg += ' token "' + bold(token) + '"';
          }
          report.log(msg);
        } else {
          report.log(`No need to logout, you're not logged in`);
        }
      };

      loadAvoJson()
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGOUT,
            cliInvokedByCi: invokedByCi()
          });
          command();
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.LOGOUT,
            cliInvokedByCi: invokedByCi()
          });
          command();
        });
    }
  })
  .command({
    command: 'whoami',
    desc: 'Shows the currently logged in username',
    handler: argv => {
      let command = () => {
        requireAuth(argv, () => {
          if (conf.has('user')) {
            let user = conf.get('user');
            report.info(`Logged in as ${email(user.email)}`);
          } else {
            report.warn(`Not logged in`);
          }
        });
      };

      loadAvoJson()
        .then(json => {
          Avo.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.WHOAMI,
            cliInvokedByCi: invokedByCi()
          });
          command();
        })
        .catch(() => {
          Avo.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: Avo.CliAction.WHOAMI,
            cliInvokedByCi: invokedByCi()
          });
          command();
        });
    }
  })

  .demandCommand(1, 'must provide a valid command')
  .recommendCommands()
  .help().argv;

/////////////////////////////////////////////////////////////////////////
// LOGGING

function cmd(command) {
  return `${gray('`')}${cyan(command)}${gray('`')}`;
}

function link(url) {
  return underline(url);
}

function file(url) {
  return underline(url);
}

function email(email) {
  return underline(email);
}

function cancelWait() {
  if (_cancel !== null) {
    _cancel();
    _cancel = null;
  }
}
function wait(message, timeOut) {
  cancelWait();
  timeOut = timeOut || 300;
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

/////////////////////////////////////////////////////////////////////////
// AUTH

function _haveValidAccessToken(refreshToken) {
  if (_.isEmpty(lastAccessToken)) {
    var tokens = conf.get('tokens');
    if (refreshToken === _.get(tokens, 'refreshToken')) {
      lastAccessToken = tokens;
    }
  }

  return (
    _.has(lastAccessToken, 'idToken') &&
    lastAccessToken.refreshToken === refreshToken &&
    _.has(lastAccessToken, 'expiresAt') &&
    lastAccessToken.expiresAt > Date.now() + FIFTEEN_MINUTES_IN_MS
  );
}

function getAccessToken(refreshToken) {
  if (_haveValidAccessToken(refreshToken)) {
    return Promise.resolve(lastAccessToken);
  }

  return _refreshAccessToken(refreshToken);
}

function _refreshAccessToken(refreshToken) {
  return api
    .request('POST', '/auth/refresh', {
      origin: api.apiOrigin,
      data: {
        token: refreshToken
      }
    })
    .then(
      function(res) {
        if (res.status === 401 || res.status === 400) {
          return {idToken: refreshToken};
        }

        if (!_.isString(res.body.idToken)) {
          throw INVALID_CREDENTIAL_ERROR;
        }
        lastAccessToken = _.assign(
          {
            expiresAt: Date.now() + res.body.expiresIn * 1000,
            refreshToken: refreshToken
          },
          res.body
        );

        var currentRefreshToken = _.get(conf.get('tokens'), 'refreshToken');
        if (refreshToken === currentRefreshToken) {
          conf.set('tokens', lastAccessToken);
        }

        return lastAccessToken;
      },
      function(err) {
        throw INVALID_CREDENTIAL_ERROR;
      }
    );
}

function _getLoginUrl(callbackUrl) {
  return (
    api.authOrigin +
    '/auth/cli?' +
    _.map(
      {
        state: nonce,
        redirect_uri: callbackUrl
      },
      function(v, k) {
        return k + '=' + encodeURIComponent(v);
      }
    ).join('&')
  );
}

function _loginWithLocalhost(port) {
  return new Promise(function(resolve, reject) {
    var callbackUrl = _getCallbackUrl(port);
    var authUrl = _getLoginUrl(callbackUrl);

    var server = http.createServer(function(req, res) {
      var tokens;
      var query = _.get(url.parse(req.url, true), 'query', {});

      if (query.state === nonce && _.isString(query.code)) {
        return _getTokensFromAuthorizationCode(query.code, callbackUrl)
          .then(function(result) {
            tokens = result;
            return _respondWithRedirect(
              req,
              res,
              api.authOrigin + '/auth/cli/success'
            );
          })
          .then(function() {
            cancelWait();
            server.shutdown();
            return resolve({
              user: jwt.decode(tokens.idToken),
              tokens: tokens
            });
          })
          .catch(function() {
            return _respondWithRedirect(
              req,
              res,
              api.authOrigin + '/auth/cli/error'
            );
          });
      }
      _respondWithRedirect(req, res, api.authOrigin + '/auth/cli/error');
    });

    server = require('http-shutdown')(server);

    server.listen(port, function() {
      report.info(`Visit this URL on any device to login: ${link(authUrl)}`);
      wait(`Waiting for authentication...`);

      opn(authUrl, {wait: false});
    });

    server.on('error', function() {
      _loginWithoutLocalhost().then(resolve, reject);
    });
  });
}

function _loginWithoutLocalhost() {
  var callbackUrl = _getCallbackUrl();
  var authUrl = _getLoginUrl(callbackUrl);

  report.info(`Visit this URL on any device to login: ${url(authUrl)}`);

  opn(authUrl, {wait: false});
}

function login() {
  return _getPort().then(_loginWithLocalhost, _loginWithoutLocalhost);
}

function _respondWithRedirect(req, res, url) {
  return new Promise(function(resolve, reject) {
    res.writeHead(302, {
      Location: url
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
      data: {
        token: code,
        redirect_uri: callbackUrl
      }
    })
    .then(
      function(res) {
        if (!_.has(res, 'body.idToken') && !_.has(res, 'body.refreshToken')) {
          throw INVALID_CREDENTIAL_ERROR;
        }
        lastAccessToken = _.assign(
          {
            expiresAt: Date.now() + res.body.expiresIn * 1000
          },
          res.body
        );
        return lastAccessToken;
      },
      function(err) {
        throw INVALID_CREDENTIAL_ERROR;
      }
    );
}

function _getCallbackUrl(port) {
  if (_.isUndefined(port)) {
    return 'urn:ietf:wg:oauth:2.0:oob';
  }
  return 'http://localhost:' + port;
}

function logout(refreshToken) {
  if (lastAccessToken.refreshToken === refreshToken) {
    lastAccessToken = {};
  }
  var tokens = conf.get('tokens');
  var currentToken = _.get(tokens, 'refreshToken');
  if (refreshToken === currentToken) {
    conf.delete('user');
    conf.delete('tokens');
  }
}

function responseToError(response, body) {
  if (typeof body === 'string' && response.statusCode === 404) {
    body = {
      error: {
        message: 'Not Found'
      }
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
    var message = response.statusCode === 404 ? 'Not Found' : 'Unknown Error';
    body.error = {
      message: message
    };
  }

  var message = `HTTP Error: ${response.statusCode}, ${body.error.message ||
    body.error}`;

  var exitCode;
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
      body: body,
      response: response
    },
    exit: exitCode
  });
}

function requireAuth(argv, cb) {
  let tokens = conf.get('tokens');
  let user = conf.get('user');

  let tokenOpt = argv.token || process.env.AVO_TOKEN;

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

//////////////////// ////////
// catch unhandled promises

process.on('unhandledRejection', err => {
  cancelWait();

  if (!(err instanceof Error) && !(err instanceof AvoError)) {
    err = new AvoError(`Promise rejected with value: ${util.inspect(err)}`);
  }
  report.error(err.message);
  // console.error(err.stack);

  process.exit(1);
});
