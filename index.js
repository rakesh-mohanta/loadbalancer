var http = require('http');
var https = require('https');
var httpProxy = require('http-proxy');
var url = require('url');
var domain = require('domain');
var EventEmitter = require('events').EventEmitter;
var async = require('async');

var LoadBalancer = function (options) {
  var self = this;

  this._errorDomain = domain.create();
  this._errorDomain.on('error', function (err) {
    if (!err.message || (err.message != 'read ECONNRESET' && err.message != 'socket hang up')) {
      self.emit('error', err);
    }
  });

  this.MIDDLEWARE_REQUEST = 'request';
  this.MIDDLEWARE_UPGRADE = 'upgrade';

  this._middleware = {};
  this._middleware[this.MIDDLEWARE_REQUEST] = [];
  this._middleware[this.MIDDLEWARE_UPGRADE] = [];

  this.protocol = options.protocol;
  this.protocolOptions = options.protocolOptions;

  this.sourcePort = options.sourcePort;
  this.host = options.host;

  this.dataKey = options.dataKey;
  this.statusCheckInterval = options.statusCheckInterval || 5000;
  this.checkStatusTimeout = options.checkStatusTimeout || 10000;
  this.statusURL = options.statusURL || '/~status';
  this.balancerCount = options.balancerCount || 1;
  this.appBalancerControllerPath = options.appBalancerControllerPath;
  this.useSmartBalancing = options.useSmartBalancing;
  
  this._destRegex = /^([^_]*)_([^_]*)_([^_]*)_/;
  this._sidRegex = /([^A-Za-z0-9]|^)s?sid=([^;]*)/;

  this.setWorkers(options.workers);

  this._proxyHTTP = this._errorDomain.bind(this._proxyHTTP.bind(this));
  this._proxyWebSocket = this._errorDomain.bind(this._proxyWebSocket.bind(this));

  this.workerStatuses = {};
  this.workerQuotas = [];

  this._proxy = httpProxy.createProxyServer({
    xfwd: true,
    ws: true
  });

  this._proxy.on('error', function (err, req, res) {
    if (res.writeHead) {
      res.writeHead(500, {
        'Content-Type': 'text/html'
      });
    }

    res.end('Proxy error - ' + (err.message || err));
  });

  if (this.protocol == 'https') {
    this._server = https.createServer(this.protocolOptions, this._handleRequest.bind(this));
  } else {
    this._server = http.createServer(this._handleRequest.bind(this));
  }

  this._errorDomain.add(this._server);

  this._server.on('upgrade', this._handleUpgrade.bind(this));
  
  if (this.useSmartBalancing) {
    setInterval(this._errorDomain.bind(this._updateStatus.bind(this)), this.statusCheckInterval);
  }
};

LoadBalancer.prototype = Object.create(EventEmitter.prototype);

LoadBalancer.prototype.start = function () {
  var self = this;
  
  if (this.appBalancerControllerPath) {
    this._errorDomain.run(function () {
      self.balancerController = require(self.appBalancerControllerPath);
      self.balancerController.run(self);
    });
  }

  this._server.listen(this.sourcePort);
};

LoadBalancer.prototype.addMiddleware = function (type, middleware) {
  this._middleware[type].push(middleware);
};

LoadBalancer.prototype._handleRequest = function (req, res) {
  var self = this;
  
  var requestMiddleware = this._middleware[this.MIDDLEWARE_REQUEST];
  if (requestMiddleware.length) {
    async.applyEachSeries(requestMiddleware, req, res, function (err) {
      if (err) {
        self._errorDomain.emit('error', err);
      } else {
        self._proxyHTTP(req, res);
      }
    });
  } else {
    this._proxyHTTP(req, res);
  }
};

LoadBalancer.prototype._handleUpgrade = function (req, socket, head) {
  var self = this;
  
  var upgradeMiddleware = this._middleware[this.MIDDLEWARE_UPGRADE];
  if (upgradeMiddleware.length) {
    async.applyEachSeries(upgradeMiddleware, req, socket, head, function (err) {
      if (err) {
        self._errorDomain.emit('error', err);
      } else {
        self._proxyWebSocket(req, socket, head);
      }
    });
  } else {
    this._proxyWebSocket(req, socket, head);
  }
};

LoadBalancer.prototype._proxyHTTP = function (req, res) {
  var dest;
  if (this.useSmartBalancing) {
    dest = this._parseSessionDest(req);
    if (dest) {
      if (this.destPorts[dest.port] == null) {
        dest.port = this._chooseTargetPort();
      }
    } else {
      dest = {
        host: 'localhost',
        port: this._chooseTargetPort()
      };
    }
  } else {
    dest = this._parseIPDest(req);
  }
  this._proxy.web(req, res, {
    target: dest
  });
};

LoadBalancer.prototype._proxyWebSocket = function (req, socket, head) {
  var dest;
  if (this.useSmartBalancing) {
    dest = this._parseSessionDest(req);
    if (dest) {
      if (this.destPorts[dest.port] == null) {
        dest.port = this._randomPort();
      }
    } else {
      dest = {
        host: 'localhost',
        port: this._chooseTargetPort()
      };
    }
  } else {
    dest = this._parseIPDest(req);
  }
  this._proxy.ws(req, socket, head, {
    target: dest
  });
};

LoadBalancer.prototype.setWorkers = function (workers) {
  this.destPorts = {};
  var i;

  for (i in workers) {
    this.destPorts[workers[i].port] = 1;
  }
  this.workers = workers;
};

LoadBalancer.prototype._randomPort = function () {
  var rand = Math.floor(Math.random() * this.workers.length);
  return this.workers[rand].port;
};

LoadBalancer.prototype._chooseTargetPort = function () {
  if (this.workerQuotas.length) {
    var leastBusyWorker = this.workerQuotas[this.workerQuotas.length - 1];
    leastBusyWorker.quota--;
    if (leastBusyWorker.quota < 1) {
      this.workerQuotas.pop();
    }
    return leastBusyWorker.port;
  }
  return this._randomPort();
};

LoadBalancer.prototype._calculateWorkerQuotas = function () {
  var clientCount;
  var maxClients = 0;
  var workerClients = {};
  this.workerQuotas = [];

  for (var i in this.workerStatuses) {
    if (this.workerStatuses[i]) {
      clientCount = this.workerStatuses[i].clientCount;

      if (clientCount > maxClients) {
        maxClients = clientCount;
      }
    } else {
      clientCount = Infinity;
    }
    workerClients[i] = clientCount;
  }

  for (var j in workerClients) {
    var targetQuota = Math.round((maxClients - workerClients[j]) / this.balancerCount);
    if (targetQuota > 0) {
      this.workerQuotas.push({
        port: j,
        quota: targetQuota
      });
    }
  }

  this.workerQuotas.sort(function (a, b) {
    return a.quota - b.quota;
  });
};

LoadBalancer.prototype._updateStatus = function () {
  var self = this;
  var statusesRead = 0;
  var workerCount = this.workers.length;

  var body = {
    dataKey: self.dataKey
  };

  for (var i in this.workers) {
    (function (worker) {
      var options = {
        hostname: 'localhost',
        port: worker.port,
        method: 'POST',
        path: self.statusURL
      };

      var req = http.request(options, function (res) {
        res.setEncoding('utf8');
        var buffers = [];

        res.on('data', function (chunk) {
          buffers.push(chunk);
        });

        res.on('end', function () {
          var result = Buffer.concat(buffers).toString();
          if (result) {
            try {
              self.workerStatuses[worker.port] = JSON.parse(result);
            } catch (err) {
              self.workerStatuses[worker.port] = null;
            }
          } else {
            self.workerStatuses[worker.port] = null;
          }

          if (++statusesRead >= workerCount) {
            self._calculateWorkerQuotas.call(self);
          }
        });
      });

      req.on('socket', function (socket) {
        socket.setTimeout(self.checkStatusTimeout);
        socket.on('timeout', function () {
          req.abort();
        })
      });

      req.write(JSON.stringify(body));
      req.end();
    })(this.workers[i]);
  }
};

LoadBalancer.prototype._hash = function (str, maxValue) {
  var ch;
  var hash = 0;
  if (str.length == 0) return hash;
  for (var i = 0; i < str.length; i++) {
    ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return Math.abs(hash) % maxValue;
};

LoadBalancer.prototype._parseIPDest = function (req) {
  if (req.connection) {
    var ipAddress;
    var headers = req.headers || {};
    var forwardedFor = headers['x-forwarded-for'];
    if (forwardedFor) {
      var forwardedClientIP;
      // For efficiency purposes since in many cases there won't be a comma
      if (forwardedFor.indexOf(',') > -1) {
        forwardedClientIP = forwardedFor.split(',')[0];
      } else {
        forwardedClientIP = forwardedFor;
      }
      ipAddress = forwardedClientIP;
    } else {
      ipAddress = req.connection.remoteAddress;
    }
    
    var workerIndex = this._hash(ipAddress, this.workers.length);
    var destPort = this.workers[workerIndex].port;
    
    var dest = {
      host: 'localhost',
      port: destPort
    };
    return dest;
  }
  return null;
};

LoadBalancer.prototype._parseSessionDest = function (req) {
  if (!req.headers || !req.headers.host) {
    return null;
  }

  var urlData = url.parse(req.url);
  var query = urlData.query || '';
  var cookie = '';

  if (req.headers && req.headers.cookie) {
    cookie = req.headers.cookie;
  }

  if (!query && !cookie) {
    return null;
  }

  var matches = query.match(this._sidRegex) || cookie.match(this._sidRegex);

  if (!matches) {
    return null;
  }

  var routString = matches[2];
  var destMatch = routString.match(this._destRegex);

  if (!destMatch) {
    return null;
  }

  var destPort = parseInt(destMatch[2]);

  if (!destPort) {
    return null;
  }

  var dest = {
    host: 'localhost',
    port: destPort
  };

  return dest;
};

module.exports = LoadBalancer;