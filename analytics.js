// Generated by Avo VERSION 18.12.0, PLEASE EDIT WITH CARE

var __DEV__ = false;

/*eslint-disable */
// polyfill Array.isArray
if (!Array.isArray) {
  Array.isArray = function(arg) {
    return Object.prototype.toString.call(arg) === '[object Array]';
  };
}

// polyfill Object.assign
if (typeof Object.assign !== 'function') {
  // Must be writable: true, enumerable: false, configurable: true
  Object.defineProperty(Object, "assign", {
    value: function assign(target, varArgs) { // .length of function is 2
      if (target == null) { // TypeError if undefined or null
        throw new TypeError('Cannot convert undefined or null to object');
      }

      var to = Object(target);

      for (var index = 1; index < arguments.length; index++) {
        var nextSource = arguments[index];

        if (nextSource != null) { // Skip over if undefined or null
          for (var nextKey in nextSource) {
            // Avoid bugs when hasOwnProperty is shadowed
            if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
              to[nextKey] = nextSource[nextKey];
            }
          }
        }
      }
      return to;
    },
    writable: true,
    configurable: true
  });
}

// From https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys
if (!Object.keys) {
  Object.keys = (function() {
    'use strict';
    var hasOwnProperty = Object.prototype.hasOwnProperty,
        hasDontEnumBug = !({ toString: null }).propertyIsEnumerable('toString'),
        dontEnums = [
          'toString',
          'toLocaleString',
          'valueOf',
          'hasOwnProperty',
          'isPrototypeOf',
          'propertyIsEnumerable',
          'constructor'
        ],
        dontEnumsLength = dontEnums.length;

    return function(obj) {
      if (typeof obj !== 'function' && (typeof obj !== 'object' || obj === null)) {
        throw new TypeError('Object.keys called on non-object');
      }

      var result = [], prop, i;

      for (prop in obj) {
        if (hasOwnProperty.call(obj, prop)) {
          result.push(prop);
        }
      }

      if (hasDontEnumBug) {
        for (i = 0; i < dontEnumsLength; i++) {
          if (hasOwnProperty.call(obj, dontEnums[i])) {
            result.push(dontEnums[i]);
          }
        }
      }
      return result;
    };
  }());
}

// polyfill Array.indexOf
if (!Array.prototype.indexOf)  Array.prototype.indexOf = (function(Object, max, min){
  "use strict";
  return function indexOf(member, fromIndex) {
    if(this===null||this===undefined)throw TypeError("Array.prototype.indexOf called on null or undefined");

    var that = Object(this), Len = that.length >>> 0, i = min(fromIndex | 0, Len);
    if (i < 0) i = max(0, Len+i); else if (i >= Len) return -1;

    if(member===void 0){ for(; i !== Len; ++i) if(that[i]===void 0 && i in that) return i; // undefined
    }else if(member !== member){   for(; i !== Len; ++i) if(that[i] !== that[i]) return i; // NaN
    }else                           for(; i !== Len; ++i) if(that[i] === member) return i; // all else

    return -1; // if the value was not found, then return -1
  };
})(Object, Math.max, Math.min);

function array_difference(a1, a2) {
  var result = [];
  for (var i = 0; i < a1.length; i++) {
    if (a2.indexOf(a1[i]) === -1) {
      result.push(a1[i]);
    }
  }
  return result;
}
/*eslint-enable */

var AvoAssert = {
  assertString: function assertString(propName, str) {
    if (typeof str !== 'string') {
      console.warn(
        propName +
          ' should be of type string but you provided type ' +
          typeof str +
          ' with value ' +
          JSON.stringify(str)
      );
    }
  },

  assertInt: function assertInt(propName, int) {
    if (typeof int === 'number' && int !== Math.round(int)) {
      console.warn(
        propName +
          ' should be of type int but you provided type float with value ' +
          JSON.stringify(int)
      );
    } else if (typeof int !== 'number') {
      console.warn(
        propName +
          ' should be of type int but you provided type ' +
          typeof int +
          ' with value ' +
          JSON.stringify(int)
      );
    }
  },

  assertFloat: function assertFloat(propName, float) {
    if (typeof float !== 'number') {
      console.warn(
        propName +
          ' should be of type float but you provided type ' +
          typeof float +
          ' with value ' +
          JSON.stringify(float)
      );
    }
  },

  assertBool: function assertBool(propName, bool) {
    if (typeof bool !== 'boolean') {
      console.warn(
        propName +
          ' should be of type boolean but you provided type ' +
          typeof bool +
          ' with value ' +
          JSON.stringify(bool)
      );
    }
  },

  assertMax: function assertMax(propName, max, value) {
    if (value > max) {
      console.warn(
        propName,
        'has a maximum value of',
        max,
        'but you provided the value',
        JSON.stringify(value)
      );
    }
  },

  assertMin: function assertMin(propName, min, value) {
    if (value < min) {
      console.warn(
        propName,
        'has a minimum value of',
        min,
        'but you provided the value',
        JSON.stringify(value)
      );
    }
  },

  assertList: function assertList(propName, type, value) {
    if (!Array.isArray(value)) {
      console.warn(
        propName + ' should be of type list but you provided type ' + typeof value
      );
    } else {
      value.forEach(function(val, index) {
        var assertFunction =
          'assert' + type.charAt(0).toUpperCase() + type.slice(1);
        AvoAssert[assertFunction](
          'item at index ' + index + ' in ' + propName,
          val
        );
      });
    }
  },

  assertNoAdditionalProperties: function assertNoAdditionalProperties(eventName, properties) {
    console.warn("[avo] Additional properties when sending event", eventName, properties);
  }
};

var AvoLogger = {
  logEventSent: function logEventSent(eventName, eventProperties, userProperties) {
    console.log("[avo] Event Sent:", eventName, "Event Props:", eventProperties, "User Props:", userProperties);
  }
};

var SignInError = {
  UNKNOWN: "Unknown",
  WRONG_PASSWORD: "Wrong Password",
  USER_NOT_FOUND: "User Not Found",
  USER_DISABLED: "User Disabled",
  INVALID_EMAIL: "Invalid Email",
};

var Client = {
  CLOUD_FUNCTIONS: "Cloud Functions",
  DESKTOP: "Desktop",
  WEB: "Web",
  LANDING_PAGE: "Landing Page",
  CLI: "Cli",
};

var CliAction = {
  LOGIN: "Login",
  LOGOUT: "Logout",
  PULL: "Pull",
  CHECKOUT: "Checkout",
  INIT: "Init",
  STATUS: "Status",
  BRANCH: "Branch",
  EDIT: "Edit",
  WHOAMI: "Whoami",
  SOURCE: "Source",
  SOURCE_ADD: "Source Add",
  SOURCE_REMOVE: "Source Remove",
};

var sysClient;
var sysVersion;

function setSystemProperties_(properties) {
  if (properties.client) {
    sysClient = properties.client;
    assertClient(sysClient);
  }
  if (properties.version) {
    sysVersion = properties.version;
    assertVersion(sysVersion);
  }
}


var CustomNodeJS;
function setup_(options, systemProperties, CustomNodeJSDestination,
  destinationOptions) {
  if (options.validateProperties === true) {
    __DEV__ = true;
  }
  
  setSystemProperties_(systemProperties);
  
  destinationOptions = destinationOptions || {};
  
  if (options.useProductionKey) {
  } else {
  }
  
  CustomNodeJS = CustomNodeJSDestination;
  CustomNodeJS.make(options.useProductionKey);
}

function assertSignInError(signInError) {
  AvoAssert.assertString("Sign In Error", signInError);
  if ("Unknown" !== signInError && "Wrong Password" !== signInError &&
        "User Not Found" !== signInError &&
        "User Disabled" !== signInError && "Invalid Email" !== signInError) {
    console.error("Sign In Error should match one of the following values [ Unknown | Wrong Password | User Not Found | User Disabled | Invalid Email ] but you provided the value " + signInError);
  }
}

function assertVersion(version) {
  AvoAssert.assertString("Version", version);
}

function assertSchemaId(schemaId) {
  AvoAssert.assertString("Schema Id", schemaId);
}

function assertEmailInput(emailInput) {
  AvoAssert.assertString("Email Input", emailInput);
}

function assertEmail(email) {
  AvoAssert.assertString("Email", email);
}

function assertClient(client) {
  AvoAssert.assertString("Client", client);
  if ("Cloud Functions" !== client && "Desktop" !== client &&
        "Web" !== client && "Landing Page" !== client && "Cli" !== client) {
    console.error("Client should match one of the following values [ Cloud Functions | Desktop | Web | Landing Page | Cli ] but you provided the value " + client);
  }
}

function assertCliInvokedByCi(cliInvokedByCi) {
  AvoAssert.assertBool("Cli Invoked by Ci", cliInvokedByCi);
}

function assertCliAction(cliAction) {
  AvoAssert.assertString("Cli Action", cliAction);
  if ("Login" !== cliAction && "Logout" !== cliAction &&
        "Pull" !== cliAction && "Checkout" !== cliAction &&
        "Init" !== cliAction && "Status" !== cliAction &&
        "Branch" !== cliAction && "Edit" !== cliAction &&
        "Whoami" !== cliAction && "Source" !== cliAction &&
        "Source Add" !== cliAction && "Source Remove" !== cliAction) {
    console.error("Cli Action should match one of the following values [ Login | Logout | Pull | Checkout | Init | Status | Branch | Edit | Whoami | Source | Source Add | Source Remove ] but you provided the value " + cliAction);
  }
}

function assertUserId_(userId_) {
  AvoAssert.assertString("User Id", userId_);
}

function assertUserId_(userId_) {
  AvoAssert.assertString("User Id", userId_);
}

/**
 * Signed In: Sent when user successfully signs in or when we successfully authenticate a user.
 * 
 * @param {Object} properties - the properties associatied with this event
 * @param {string} properties.userId_ - The value used to identify the user. Make sure it's a unique sequence of characters used to identify the user.
 * @param {string} properties.email - The user's email
 * 
 * @see {@link https://www.avo.app/schemas/fwtXqAc0fCLy7b7oGW40/events/54e92613-090c-4f0b-afeb-ed720eff3422}
 */
function signedIn(properties) {
  properties = properties || {};
  // assert properties
  if (__DEV__) {
    assertUserId_(properties.userId_);
    assertEmail(properties.email);
    assertClient(sysClient);
    assertVersion(sysVersion);
    var additionalKeys = array_difference(Object.keys(properties), [
      "userId_",
      "email"
    ]);
    if (additionalKeys.length) {
      AvoAssert.assertNoAdditionalProperties("Signed In", additionalKeys);
    }
  }
  
  if (__DEV__) {
    AvoLogger.logEventSent("Signed In", {
      "Client": sysClient,
      "Version": sysVersion,
    }, {
      "Email": properties.email,
    });
  }
  
  Promise.all([
    // destination CustomNodeJS
    CustomNodeJS.logEvent(properties.userId_, "Signed In", {
      "Client": sysClient,
      "Version": sysVersion,
    }),
  ]);
}

/**
 * Sign In Failed: Sent when sign in request fails.
 * 
 * @param {Object} properties - the properties associatied with this event
 * @param {string} properties.userId_ - User Id is required for server sources.
 * @param {string} properties.signInError - no description
 * @param {string} properties.emailInput - no description
 * 
 * @see {@link https://www.avo.app/schemas/fwtXqAc0fCLy7b7oGW40/events/7aa64217-bb89-44f5-9a68-f3bc0255a864}
 */
function signInFailed(properties) {
  properties = properties || {};
  // assert properties
  if (__DEV__) {
    assertUserId_(properties.userId_);
    assertSignInError(properties.signInError);
    assertEmailInput(properties.emailInput);
    assertClient(sysClient);
    assertVersion(sysVersion);
    var additionalKeys = array_difference(Object.keys(properties), [
      "userId_",
      "signInError",
      "emailInput"
    ]);
    if (additionalKeys.length) {
      AvoAssert.assertNoAdditionalProperties("Sign In Failed", additionalKeys);
    }
  }
  
  if (__DEV__) {
    AvoLogger.logEventSent("Sign In Failed", {
      "Sign In Error": properties.signInError,
      "Email Input": properties.emailInput,
      "Client": sysClient,
      "Version": sysVersion,
    }, {});
  }
  
  Promise.all([
    // destination CustomNodeJS
    CustomNodeJS.logEvent(properties.userId_, "Sign In Failed", {
      "Sign In Error": properties.signInError,
      "Email Input": properties.emailInput,
      "Client": sysClient,
      "Version": sysVersion,
    }),
  ]);
}

/**
 * Cli Invoked: Sent when any action is made in the CLI.
 * 
 * @param {Object} properties - the properties associatied with this event
 * @param {string} properties.userId_ - User Id is required for server sources.
 * @param {string} properties.cliAction - no description
 * @param {string} properties.schemaId - The ID of the schema that this event is related to.
 * @param {bool} properties.cliInvokedByCi - True iff process.env.CI is set.
 * 
 * @see {@link https://www.avo.app/schemas/fwtXqAc0fCLy7b7oGW40/events/qqpIQEK11}
 */
function cliInvoked(properties) {
  properties = properties || {};
  // assert properties
  if (__DEV__) {
    assertUserId_(properties.userId_);
    assertCliAction(properties.cliAction);
    assertSchemaId(properties.schemaId);
    assertCliInvokedByCi(properties.cliInvokedByCi);
    assertClient(sysClient);
    assertVersion(sysVersion);
    var additionalKeys = array_difference(Object.keys(properties), [
      "userId_",
      "cliAction",
      "schemaId",
      "cliInvokedByCi"
    ]);
    if (additionalKeys.length) {
      AvoAssert.assertNoAdditionalProperties("Cli Invoked", additionalKeys);
    }
  }
  
  if (__DEV__) {
    AvoLogger.logEventSent("Cli Invoked", {
      "Cli Action": properties.cliAction,
      "Schema Id": properties.schemaId,
      "Cli Invoked by Ci": properties.cliInvokedByCi,
      "Client": sysClient,
      "Version": sysVersion,
    }, {});
  }
  
  Promise.all([
    // destination CustomNodeJS
    CustomNodeJS.logEvent(properties.userId_, "Cli Invoked", {
      "Cli Action": properties.cliAction,
      "Schema Id": properties.schemaId,
      "Cli Invoked by Ci": properties.cliInvokedByCi,
      "Client": sysClient,
      "Version": sysVersion,
    }),
  ]);
}

/**
 * Cli Installed: Event sent when the CLI is successfully installed
 * 
 * @param {Object} properties - the properties associatied with this event
 * @param {string} properties.userId_ - User Id is required for server sources.
 * @param {bool} properties.cliInvokedByCi - True iff process.env.CI is set.
 * 
 * @see {@link https://www.avo.app/schemas/fwtXqAc0fCLy7b7oGW40/events/JCwfVYXTS}
 */
function cliInstalled(properties) {
  properties = properties || {};
  // assert properties
  if (__DEV__) {
    assertUserId_(properties.userId_);
    assertCliInvokedByCi(properties.cliInvokedByCi);
    assertClient(sysClient);
    assertVersion(sysVersion);
    var additionalKeys = array_difference(Object.keys(properties), [
      "userId_",
      "cliInvokedByCi"
    ]);
    if (additionalKeys.length) {
      AvoAssert.assertNoAdditionalProperties("Cli Installed", additionalKeys);
    }
  }
  
  if (__DEV__) {
    AvoLogger.logEventSent("Cli Installed", {
      "Cli Invoked by Ci": properties.cliInvokedByCi,
      "Client": sysClient,
      "Version": sysVersion,
    }, {});
  }
  
  Promise.all([
    // destination CustomNodeJS
    CustomNodeJS.logEvent(properties.userId_, "Cli Installed", {
      "Cli Invoked by Ci": properties.cliInvokedByCi,
      "Client": sysClient,
      "Version": sysVersion,
    }),
  ]);
}

exports.SignInError = SignInError;
exports.Client = Client;
exports.CliAction = CliAction;
exports.signedIn = signedIn;
exports.signInFailed = signInFailed;
exports.cliInvoked = cliInvoked;
exports.cliInstalled = cliInstalled;
exports.setSystemProperties_ = setSystemProperties_;
exports.setup_ = setup_;
