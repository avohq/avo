#!/usr/bin/env node
const _ = require('lodash');
const {cyan, gray, red, bold, underline} = require('chalk');
const fs = require('fs');
const http = require('http');
const inquirer = require('inquirer');
const jwt = require('jsonwebtoken');
const loadJsonFile = require('load-json-file');
const logSymbols = require('log-symbols');
const opn = require('opn');
const ora = require('ora');
const path = require('path');
const portfinder = require('portfinder');
const querystring = require('querystring');
const request = require('request');
const semver = require('semver');
const updateNotifier = require('update-notifier');
const url = require('url');
const util = require('util');
const uuidv4 = require('uuid/v4');
const writeFile = require('write');
const writeJsonFile = require('write-json-file');
const Configstore = require('configstore');
const pkg = require('./package.json');

const analytics = require('./analytics.js');

const customAnalyticsDestination = {
  make: function make(production) {
    this.production = production;
  },

  logEvent: function logEvent(userId, eventName, eventProperties) {
    api.request('POST', '/c/v1/track', {
      origin: api.apiOrigin,
      data: {
        userId: userId,
        eventName: eventName,
        eventProperties: eventProperties
      }
    });
  }
};
// setup Avo analytics
analytics.setup_(
  {validateProperties: false, useProductionKey: true},
  {client: analytics.Client.CLI, version: pkg.version},
  customAnalyticsDestination
);

// register inquirer-file-path
inquirer.registerPrompt('directory', require('inquirer-select-directory'));

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
  info(
    `Authentication Error: Your credentials are no longer valid. Please run ${cmd(
      'avo logout; avo login'
    )}`
  ),
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
        json: true
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

function loadAvoJson() {
  return loadJsonFile('avo.json')
    .then(json => {
      if (avoNeedsUpdate(json)) {
        throw new AvoError(error(`Your avo CLI is outdated, please update`));
      }

      if (isLegacyAvoJson(json)) {
        throw new AvoError(
          error(`Project is not initialized. Run ${cmd('avo init')}`)
        );
      }

      // augment the latest major version into avo.json
      json.avo = Object.assign({}, json.avo || {}, {
        version: semver.major(pkg.version)
      });

      return json;
    })
    .catch(err => {
      if (err.code === 'ENOENT') {
        throw new AvoError(
          error(
            `File ${file('avo.json')} does not exist. Run ${cmd('avo init')}`
          )
        );
      } else {
        throw err;
      }
    });
}

function loadAvoJsonOrInit() {
  return loadJsonFile('avo.json')
    .then(json => {
      if (avoNeedsUpdate(json)) {
        throw new AvoError(error(`Your avo CLI is outdated, please update`));
      }

      if (isLegacyAvoJson(json)) {
        return init();
      }

      // augment the latest major version into avo.json
      json.avo = Object.assign({}, json.avo || {}, {
        version: semver.major(pkg.version)
      });

      return json;
    })
    .catch(err => {
      if (err.code === 'ENOENT') {
        return init();
      } else {
        throw err;
      }
    });
}

function init() {
  let writeAvoJson = schema => {
    let json = {
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
    return writeJsonFile('avo.json', json, {indent: 2}).then(() => {
      return json;
    });
  };
  wait('Fetching workspaces');
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
        let choices = schemas.map(schema => {
          return {value: schema, name: schema.name};
        });
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
            return writeAvoJson(answer.schema);
          });
      } else if (schemas.length === 0) {
        throw new AvoError(
          warn(
            `No workspaces to initialize. Go to ${link(
              'wwww.avo.app'
            )} to create one`
          )
        );
      } else {
        let schema = schemas[0];
        return writeAvoJson(schema);
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
      let updatedSource = {
        actionId: target.actionId,
        name: target.name,
        id: target.id,
        path: source.path,
        branchId: target.branchId,
        updatedAt: target.updatedAt
      };
      return updatedSource;
    } else {
      return source;
    }
  });

  let sourceTasks = targets.map(target => {
    return Promise.all(
      target.code.map(code => writeFile.promise(code.path, code.content))
    );
  });

  let avoJsonTask = writeJsonFile('avo.json', newJson, {
    indent: 2
  });

  Promise.all(_.concat([avoJsonTask], sourceTasks)).then(() => {
    print(
      success(
        `Tracking ${
          targets.length > 1 ? 'libraries' : 'library'
        } successfully updated`
      )
    );
    targets.forEach(target => {
      let source = _.find(newJson.sources, source => source.id === target.id);
      if (target.code.length === 1) {
        print(ok(`${source.name}: ${file(source.path)}`));
      } else if (target.code.length > 1) {
        print(ok(`${source.name}:`));
        target.code.forEach(code => {
          print(selected(`${file(code.path)}`));
        });
      }
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
          type: 'directory',
          name: 'folder',
          message: 'Select a folder to put the library',
          basePath: '.'
        }
      ];

      if (!sourceToAdd) {
        let choices = sources.map(source => {
          return {value: source, name: source.name};
        });

        prompts.unshift({
          type: 'list',
          name: 'source',
          message: 'Select a source to generate a tracking library for',
          choices: choices,
          pageSize: 15
        });
        prompts.push({
          type: 'input',
          name: 'filename',
          message: 'Select a filename fer the library',
          default: function(answers) {
            return answers.source.filenameHint;
          }
        });
      } else {
        let source = _.find(sources, source =>
          matchesSource(source, sourceToAdd)
        );
        if (!source) {
          throw new AvoError(fail(`Source ${sourceToAdd} does not exist`));
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
          path.join(answer.folder, answer.filename)
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
        return writeJsonFile('avo.json', newJson, {indent: 2}).then(() => {
          print(ok(`Added source ${source.name} to the project`));
        });
      });

      if (!sourceToAdd) {
      } else {
        let source = _.find(sources, source =>
          matchesSource(source, sourceToAdd)
        );
        if (!source) {
          throw new AvoError(fail(`Source ${sourceToAdd} does not exist`));
        } else {
          json = Object.assign({}, json, {
            branch: {
              id: branch.id,
              name: branch.name
            }
          });
          return writeJsonFile('avo.json', json, {indent: 2}).then(() => {
            print(info(`Switched to branch '${branch.name} (${branch.id})'`));
            return json;
          });
        }
        console.log('----');
      }
    });
}

function checkout(branchToCheckout, json) {
  wait('Fetching branches');
  return api
    .request('POST', '/c/v1/branches', {
      origin: api.apiOrigin,
      auth: true,
      data: {
        schemaId: json.schema.id
      }
    })
    .then(res => {
      cancelWait();
      let result = res.body;
      let branches = _.sortBy(result.branches, 'name');

      if (!branchToCheckout) {
        let choices = branches.map(branch => {
          return {value: branch, name: branch.name};
        });
        let currentBranch = _.find(
          branches,
          branch => branch.id == json.branch.id
        );
        inquirer
          .prompt([
            {
              type: 'list',
              name: 'branch',
              message: 'Select a branch',
              default: currentBranch,
              choices: choices,
              pageSize: 15
            }
          ])
          .then(answer => {
            if (answer.branch === currentBranch) {
              print(info(`Already on '${currentBranch.name}'`));
              return json;
            } else {
              let branch = answer.branch;
              json = Object.assign({}, json, {
                branch: {
                  id: branch.id,
                  name: branch.name
                }
              });
              return writeJsonFile('avo.json', json, {indent: 2}).then(() => {
                print(info(`Switched to branch '${branch.name}'`));
                return json;
              });
            }
          });
      } else {
        let branch = _.find(
          branches,
          branch => branch.name == branchToCheckout
        );
        if (!branch) {
          throw new AvoError(
            fail(
              `Branch ${branchToCheckout} does not exist. Run ${cmd(
                'avo branch'
              )} to list available branches`
            )
          );
        } else {
          json = Object.assign({}, json, {
            branch: {
              id: branch.id,
              name: branch.name
            }
          });
          return writeJsonFile('avo.json', json, {indent: 2}).then(() => {
            print(info(`Switched to branch '${branch.name}'`));
            return json;
          });
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
  return api
    .request('POST', '/c/v1/pull', {
      origin: api.apiOrigin,
      auth: true,
      data: {
        schemaId: json.schema.id,
        branchId: json.branch.id,
        sources: _.map(sources, source => {
          return {id: source.id, path: source.path};
        })
      }
    })
    .then(res => {
      cancelWait();
      let result = res.body;
      codegen(json, result);
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

require('yargs')
  .usage('$0 command')
  .scriptName('avo')
  .command({
    command: 'track-install',
    desc: false,
    handler: () => {
      analytics.cliInstalled({
        userId_: installIdOrUserId(),
        cliInvokedByCi: invokedByCi()
      });
    }
  })
  .command({
    command: 'init',
    desc: 'Initialize an Avo workspace in the current folder',
    handler: argv => {
      analytics.cliInvoked({
        schemaId: 'N/A',
        userId_: installIdOrUserId(),
        cliAction: analytics.CliAction.INIT,
        cliInvokedByCi: invokedByCi()
      });
      if (fs.existsSync('avo.json')) {
        let json = loadJsonFile.sync('avo.json');
        if (!isLegacyAvoJson(json)) {
          let schema = json.schema;
          print(
            info(
              `Avo is already initialized (${cyan(schema.name)}): ${file(
                'avo.json'
              )} exists`
            )
          );
          return;
        }
      }
      requireAuth(argv, () => {
        init();
      });
    }
  })
  .command({
    command: 'branch',
    desc: 'List branches',
    handler: argv => {
      let command = json => {
        requireAuth(argv, () => {
          wait('Fetching branches');
          return api
            .request('POST', '/c/v1/branches', {
              origin: api.apiOrigin,
              auth: true,
              data: {
                schemaId: json.schema.id
              }
            })
            .then(res => {
              cancelWait();
              let result = res.body;
              let branches = _.sortBy(result.branches, 'name');
              branches.forEach(branch => {
                if (branch.id === json.branch.id) {
                  print(selected(branch.name));
                } else {
                  print(item(branch.name));
                }
              });
            });
        });
      };
      loadAvoJson()
        .then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.BRANCH,
            cliInvokedByCi: invokedByCi()
          });
          command(json);
        })
        .catch(err => {
          if (err instanceof AvoError) {
            print(err.message);
          }
          analytics.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.BRANCH,
            cliInvokedByCi: invokedByCi()
          });
        });
    }
  })
  .command({
    command: 'checkout [branch]',
    desc: 'Switch branches',
    handler: argv => {
      let command = json => {
        requireAuth(argv, () => {
          checkout(argv.branch, json);
        });
      };
      loadAvoJson()
        .then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.CHECKOUT,
            cliInvokedByCi: invokedByCi()
          });
          command(json);
        })
        .catch(err => {
          if (err instanceof AvoError) {
            print(err.message);
          }
          analytics.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.CHECKOUT,
            cliInvokedByCi: invokedByCi()
          });
        });
    }
  })
  .command({
    command: 'pull [source]',
    desc: 'Download code from Avo workspace',
    builder: yargs => {
      return yargs.option('branch', {
        describe: 'Name of Avo branch to pull from',
        type: 'string'
      });
    },
    handler: argv => {
      requireAuth(argv, () => {
        loadAvoJsonOrInit().then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.PULL,
            cliInvokedByCi: invokedByCi()
          });

          let go = json => {
            if (!json.sources) {
              print(info(`No sources configured.`));
              return selectSource(argv.source, json).then(() => {
                return loadAvoJson().then(json => {
                  return pull(null, json);
                });
              });
            } else {
              return pull(argv.source, json);
            }
          };

          if (argv.branch && json.branch.name !== argv.branch) {
            return checkout(argv.branch, json).then(json => {
              return go(json);
            });
          } else {
            print(info(`Pulling from branch '${json.branch.name}'`));
            return go(json);
          }
        });
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
            let command = json => {
              requireAuth(argv, () => {
                if (!json.sources) {
                  print(
                    info(
                      `No sources defined in ${file('avo.json')}. Run ${cmd(
                        'avo source add'
                      )} to add sources`
                    )
                  );
                  return;
                }

                print(info(`In this project:`));
                _.each(json.sources, source => {
                  print(selected(`${source.name}: ${file(source.path)}`));
                });
              });
            };
            loadAvoJson()
              .then(json => {
                analytics.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: analytics.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi()
                });
                command(json);
              })
              .catch(err => {
                if (err instanceof AvoError) {
                  print(err.message);
                }
                analytics.cliInvoked({
                  schemaId: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: analytics.CliAction.SOURCE,
                  cliInvokedByCi: invokedByCi()
                });
              });
          }
        })
        .command({
          command: 'add',
          desc: 'Add a source to this project',
          handler: argv => {
            let command = json => {
              requireAuth(argv, () => {
                selectSource(null, json);
              });
            };
            loadAvoJson()
              .then(json => {
                analytics.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: analytics.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi()
                });
                command(json);
              })
              .catch(err => {
                if (err instanceof AvoError) {
                  print(err.message);
                }
                analytics.cliInvoked({
                  schemaId: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: analytics.CliAction.SOURCE_ADD,
                  cliInvokedByCi: invokedByCi()
                });
              });
          }
        })
        .command({
          command: 'remove <source>',
          aliases: ['rm'],
          desc: 'Remove a source from this project',
          handler: argv => {
            let command = json => {
              requireAuth(argv, () => {
                if (!json.sources) {
                  print(
                    info(
                      `No sources defined in ${file('avo.json')}. Run ${cmd(
                        'avo source add'
                      )} to add sources`
                    )
                  );
                  return;
                }

                let targetSource = _.find(json.sources, source => {
                  return (
                    source.name.toLowerCase() === argv.source.toLowerCase()
                  );
                });
                if (!targetSource) {
                  print(fail(`Source ${argv.source} not found in project.`));
                  return;
                }

                return inquirer
                  .prompt([
                    {
                      type: 'confirm',
                      name: 'remove',
                      default: true,
                      message: `Are you sure you want to remove source ${
                        targetSource.name
                      } from project`
                    }
                  ])
                  .then(answer => {
                    if (answer.remove) {
                      let sources = _.filter(
                        json.sources || [],
                        source => source.id !== targetSource.id
                      );
                      let newJson = Object.assign({}, json, {sources: sources});
                      return writeJsonFile('avo.json', newJson, {
                        indent: 2
                      }).then(() => {
                        // XXX ask to remove file as well?
                        print(
                          ok(`Removed source ${targetSource.name} from project`)
                        );
                      });
                    } else {
                      print(
                        info(
                          `Did not remove source ${
                            targetSource.name
                          } from project`
                        )
                      );
                    }
                  });
              });
            };
            loadAvoJson()
              .then(json => {
                analytics.cliInvoked({
                  schemaId: json.schema.id,
                  userId_: installIdOrUserId(),
                  cliAction: analytics.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi()
                });
                command(json);
              })
              .catch(err => {
                if (err instanceof AvoError) {
                  print(err.message);
                }
                analytics.cliInvoked({
                  schemaId: 'N/A',
                  userId_: installIdOrUserId(),
                  cliAction: analytics.CliAction.SOURCE_REMOVE,
                  cliInvokedByCi: invokedByCi()
                });
              });
          }
        });
    }
  })
  .command({
    command: 'edit',
    desc: 'Open the Avo workspace in your browser',
    handler: () => {
      let command = json => {
        const schema = json.schema;
        const url = `https://www.avo.app/schemas/${schema.id}`;
        print(
          info(`Opening ${cyan(schema.name)} workspace in Avo: ${link(url)}`)
        );
        opn(url, {wait: false});
      };

      loadAvoJson()
        .then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.EDIT,
            cliInvokedByCi: invokedByCi()
          });
          command(json);
        })
        .catch(err => {
          if (err instanceof AvoError) {
            print(err.message);
          }
          analytics.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.EDIT,
            cliInvokedByCi: invokedByCi()
          });
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
          print(info(`Already logged in as ${email(user.email)}`));
          return;
        }
        login()
          .then(function(result) {
            conf.set('user', result.user);
            conf.set('tokens', result.tokens);

            analytics.signedIn({
              userId_: result.user.user_id,
              email: result.user.email,
              cliInvokedByCi: invokedByCi()
            });

            print(success(`Logged in as ${email(result.user.email)}`));
          })
          .catch(() => {
            analytics.signInFailed({
              userId_: conf.get('avo_install_id'),
              emailInput: '', // XXX this is not passed back here
              signInError: analytics.SignInError.UNKNOWN,
              cliInvokedByCi: invokedByCi()
            });
          });
      };

      loadAvoJson()
        .then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.LOGIN,
            cliInvokedByCi: invokedByCi()
          });
          command();
        })
        .catch(() => {
          analytics.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.LOGIN,
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
          print(info(msg));
        } else {
          print(info(`No need to logout, you're not logged in`));
        }
      };

      loadAvoJson()
        .then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.LOGOUT,
            cliInvokedByCi: invokedByCi()
          });
          command();
        })
        .catch(() => {
          analytics.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.LOGOUT,
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
            print(info(`Logged in as ${email(user.email)}`));
          } else {
            print(error(`Not logged in`));
          }
        });
      };

      loadAvoJson()
        .then(json => {
          analytics.cliInvoked({
            schemaId: json.schema.id,
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.WHOAMI,
            cliInvokedByCi: invokedByCi()
          });
          command();
        })
        .catch(() => {
          analytics.cliInvoked({
            schemaId: 'N/A',
            userId_: installIdOrUserId(),
            cliAction: analytics.CliAction.WHOAMI,
            cliInvokedByCi: invokedByCi()
          });
          command();
        });
    }
  })
  .demand(1, 'must provide a valid command')
  .help().argv;

/////////////////////////////////////////////////////////////////////////
// LOGGING

function error(message) {
  return `${red('> Error!')} ${message}`;
}

function success(message) {
  return `${cyan('> Success!')} ${message}`;
}

function ok(message) {
  return `${logSymbols.success} ${message}`;
}

function fail(message) {
  return `${logSymbols.error} ${message}`;
}

function cmd(command) {
  return `${gray('`')}${cyan(command)}${gray('`')}`;
}

function info(message) {
  return `${gray('>')} ${message}`;
}

function selected(message) {
  return `${gray('*')} ${message}`;
}

function item(message) {
  return `  ${message}`;
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

function print(message) {
  process.stderr.write(`${message}\n`);
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
      print(info(`Visit this URL on any device to login: ${link(authUrl)}`));
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

  print(info(`Visit this URL on any device to login: ${url(authUrl)}`));

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

  var message = error(
    `HTTP Error: ${response.statusCode}, ${body.error.message || body.error}`
  );

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
    print(error(`Command requires authentication. Run ${cmd('avo login')}`));
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
  print(err.message);
  // print(err.stack);

  process.exit(1);
});
