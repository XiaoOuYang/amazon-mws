'use strict';

var http = require('http');
var https = require('https');
var objectAssign = require('object-assign');
var path = require('path');
var xml2json = require('xml2json');
var crypto = require('crypto');
var _ = require('underscore');
var qs = require('qs');

var utils = require('./utils');
var Error = require('./Error');

var hasOwn = {}.hasOwnProperty;

// Provide extension mechanism for AmazonMws Resource Sub-Classes
AmazonMwsResource.extend = utils.protoExtend;

// Expose method-creator & prepared (basic) methods
AmazonMwsResource.method = require('./AmazonMwsMethod');
AmazonMwsResource.BASIC_METHODS = require('./AmazonMwsMethod.basic.js');

/**
 * Encapsulates request logic for a AmazonMws Resource
 */
function AmazonMwsResource(AmazonMws, urlData) {
    this._AmazonMws = AmazonMws;
    this._urlData = urlData || {};

    this.basePath = utils.makeURLInterpolator(AmazonMws.getApiField('basePath'));
    this.path = utils.makeURLInterpolator(this.path);

    if (this.includeBasic) {
        this.includeBasic.forEach(function (methodName) {
            this[methodName] = AmazonMwsResource.BASIC_METHODS[methodName];
        }, this);
    }

    this.initialize.apply(this, arguments);
}

AmazonMwsResource.prototype = {

    path: '',

    initialize: function () {
    },

    // Function to override the default data processor. This allows full control
    // over how a AmazonMwsResource's request data will get converted into an HTTP
    // body. This is useful for non-standard HTTP requests. The function should
    // take method name, data, and headers as arguments.
    requestDataProcessor: null,

    // String that overrides the base API endpoint. If `overrideHost` is not null
    // then all requests for a particular resource will be sent to a base API
    // endpoint as defined by `overrideHost`.
    overrideHost: null,

    createFullPath: function (commandPath, urlData) {
        return path.join(
          this.basePath(urlData),
          this.path(urlData),
          typeof commandPath === 'function' ?
            commandPath(urlData) : commandPath
        ).replace(/\\/g, '/'); // ugly workaround for Windows
    },

    createUrlData: function () {
        var urlData = {};
        // Merge in baseData
        for (var i in this._urlData) {
            if (hasOwn.call(this._urlData, i)) {
                urlData[i] = this._urlData[i];
            }
        }
        return urlData;
    },

    wrapTimeout: function (promise, callback) {
        if (callback) {
            // Ensure callback is called outside of promise stack.
            return promise.then(function (res) {
                setTimeout(function () {
                    callback(null, res);
                }, 0);
            }, function (err) {
                setTimeout(function () {
                    callback(err, null);
                }, 0);
            });
        }

        return promise;
    },

    _timeoutHandler: function (timeout, req, callback) {
        var self = this;
        return function () {
            var timeoutErr = new Error('ETIMEDOUT');
            timeoutErr.code = 'ETIMEDOUT';

            req._isAborted = true;
            req.abort();

            callback.call(
              self,
              new Error.AmazonMwsConnectionError({
                  message: 'Request aborted due to timeout being reached (' + timeout + 'ms)',
                  detail: timeoutErr
              }),
              null
            );
        };
    },

    _responseHandler: function (req, callback) {
        var self = this;
        return function (res) {
            var response = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                //console.log('chunk ', chunk);
                response += chunk;
            });
            res.on('end', function () {
                try {
                    //console.log('XML response ', response);
                    response = xml2json.toJson(response);
                    //console.log('response ', response);
                    response = JSON.parse(response);
                    if (response.ErrorResponse) {
                        return callback.call(self, response.ErrorResponse, null);
                    }
                } catch (e) {
                    return callback.call(
                      self,
                      new Error.AmazonMwsAPIError({
                          message: 'Invalid JSON received from the AmazonMws API',
                          response: response,
                          exception: e
                      }),
                      null
                    );
                }
                // Expose res object
                Object.defineProperty(response, 'lastResponse', {
                    enumerable: false,
                    writable: false,
                    value: res
                });
                callback.call(self, null, response);
            });
        };
    },

    _errorHandler: function (req, callback) {
        var self = this;
        return function (error) {
            if (req._isAborted) {
                // already handled
                return;
            }
            callback.call(
              self,
              new Error.AmazonMwsConnectionError({
                  message: 'An error occurred with our connection to AmazonMws',
                  detail: error
              }),
              null
            );
        };
    },

    _request: function (method, path, data, auth, options, callback) {
        var self = this;
        var requestData = data;
        if (method === 'GET') {
            requestData.AWSAccessKeyId = this._AmazonMws.getApiField('key');
            requestData.Timestamp = new Date();
            requestData.SignatureVersion = '2';
            requestData.SignatureMethod = 'HmacSHA256';
            requestData.Version = '2011-07-01';
            var sorted = _.reduce(_.keys(requestData).sort(), function (m, k) {
                m[k] = requestData[k];
                return m;
            }, {});
            var stringToSign = ['GET', self._AmazonMws.getApiField('host'), path, qs.stringify(sorted)].join("\n");
            requestData.Signature = crypto.createHmac("sha256", this._AmazonMws.getApiField('secret')).update(stringToSign, 'utf8').digest("base64");
        }


        if (self.requestDataProcessor) {
            requestData = self.requestDataProcessor(method, data, options.headers);
        } else {
            requestData = utils.stringifyRequestData(data || {});
        }

        var headers = {
            //'Authorization': 'Basic ' + new Buffer(this._AmazonMws.getApiField('key')).toString('base64'),
            'Accept': 'text/xml',
            'Content-Type': 'text/xml',
            'Content-MD5': crypto.createHash('md5').update(requestData).digest('base64')
        };

        // Grab client-user-agent before making the request:
        this._AmazonMws.getClientUserAgent(function () {
            if (options.headers) {
                objectAssign(headers, options.headers);
            }
            makeRequest();
        });

        function makeRequest() {
            var timeout = self._AmazonMws.getApiField('timeout');
            var isInsecureConnection = self._AmazonMws.getApiField('protocol') === 'http';

            var host = self.overrideHost || self._AmazonMws.getApiField('host');
            var params = {
                host: host,
                port: self._AmazonMws.getApiField('port'),
                path: path,
                method: method,
                headers: headers
            };
            if (params.method === 'GET') {
                params.path = params.path + '?' + requestData
            }
            var req = (
              isInsecureConnection ? http : https
            ).request(params);
            //console.log('path ', params.path);

            req.setTimeout(timeout, self._timeoutHandler(timeout, req, callback));
            req.on('response', self._responseHandler(req, callback));
            req.on('error', self._errorHandler(req, callback));

            req.on('socket', function (socket) {
                socket.on((isInsecureConnection ? 'connect' : 'secureConnect'), function () {
                    // Send payload; we're safe:
                    req.write(requestData);
                    req.end();
                });
            });
        }
    }

};

module.exports = AmazonMwsResource;