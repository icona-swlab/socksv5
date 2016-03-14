var debug = require('debug')('server');

var net = require('net'),
    tls = require('tls'),
    dns = require('dns'),
    util = require('util'),
    inherits = util.inherits,
    EventEmitter = require('events').EventEmitter;

var Parser = require('./server.parser'),
    ipbytes = require('./utils').ipbytes;

var ATYP = require('./constants').ATYP,
    REP = require('./constants').REP;

var BUF_AUTH_NO_ACCEPT = new Buffer([0x05, 0xFF]),
    BUF_REP_INTR_SUCCESS = new Buffer([0x05,
                                       REP.SUCCESS,
                                       0x00,
                                       0x01,
                                       0x00, 0x00, 0x00, 0x00,
                                       0x00, 0x00]),
    BUF_REP_DISALLOW = new Buffer([0x05, REP.DISALLOW]),
    BUF_REP_CMDUNSUPP = new Buffer([0x05, REP.CMDUNSUPP]);

function Server(options, listener) {
  if (!(this instanceof Server))
    return new Server(options, listener);

  var self = this;

  if (typeof options === 'function') {
    self.on('connection', options);
    options = undefined;
  } else if (typeof listener === 'function')
    self.on('connection', listener);

  EventEmitter.call(this);

  function onCreate(socket) {
    if (self._connections >= self.maxConnections) {
      socket.destroy();
      return;
    }
    ++self._connections;
    socket.once('close', function(had_err) {
      --self._connections;
    });
    self._onConnection(socket);
  }

  if (options && options.tls && typeof options.tls === 'object') {
    debug('server tls:'+JSON.stringify(options.tls));
    this._srv = new tls.Server(options.tls, onCreate).on('error', function(err) {
      self.emit('error', err);
    }).on('listening', function() {
      self.emit('listening');
    }).on('close', function() {
      self.emit('close');
    });
  } else {
    this._srv = new net.Server(onCreate).on('error', function(err) {
      self.emit('error', err);
    }).on('listening', function() {
      self.emit('listening');
    }).on('close', function() {
      self.emit('close');
    });
  }

  this._auths = [];
  if (options && Array.isArray(options.auths)) {
    for (var i = 0, len = options.auths.length; i < len; ++i)
      this.useAuth(options.auths[i]);
  }
  this._debug = (options && typeof options.debug === 'function'
                 ? options.debug
                 : undefined);

  this._connections = 0;
  this.maxConnections = Infinity;
  this.bindHost = options && options.bindHost || "127.0.0.1";
  this.minBindPort = options && options.minBindPort || 10000;
  this.maxBindPort = options && options.maxBindPort || 20000;
  this.maxBindWait = options && options.maxBindPort || 60000;
}
inherits(Server, EventEmitter);

Server.prototype._onConnection = function(socket) {
  var self = this,
      parser = new Parser(socket);
  parser.on('error', function(err) {
    if (socket.writable)
      socket.end();
  }).on('methods', function(methods) {
    var auths = self._auths;
    for (var a = 0, alen = auths.length; a < alen; ++a) {
      for (var m = 0, mlen = methods.length; m < mlen; ++m) {
        if (methods[m] === auths[a].METHOD) {
          auths[a].server(socket, function(result) {
            if (result === true) {
              parser.authed = true;
              parser.start();
            } else {
              if (util.isError(result))
                self._debug && self._debug('Error: ' + result.message);
              socket.end();
            }
          });
          socket.write(new Buffer([0x05, auths[a].METHOD]));
          socket.resume();
          return;
        }
      }
    }
    socket.end(BUF_AUTH_NO_ACCEPT);
  }).on('request', function(reqInfo) {
    if (reqInfo.cmd !== 'connect' && reqInfo.cmd !== 'bind')
      return socket.end(BUF_REP_CMDUNSUPP);

    reqInfo.srcAddr = socket.remoteAddress;
    reqInfo.srcPort = socket.remotePort;

    var handled = false;

    function accept(intercept) {
      debug('accept intercept:'+intercept);
      if (handled)
        return;
      handled = true;
      if (socket.writable) {
        if (intercept) {
          socket.write(BUF_REP_INTR_SUCCESS);
          socket.removeListener('error', onErrorNoop);
          process.nextTick(function() {
            socket.resume();
          });
          return socket;
        } else {
          if (reqInfo.cmd === 'connect')
            proxySocket(socket, reqInfo);
          else
            proxyBind(socket, reqInfo, self);
        }
      }
    }
    function deny() {
      if (handled)
        return;
      handled = true;
      if (socket.writable)
        socket.end(BUF_REP_DISALLOW);
    }

    if (self._events.connection) {
      self.emit('connection', reqInfo, accept, deny);
      return;
    }

    if (reqInfo.cmd === 'connect')
      proxySocket(socket, reqInfo);
    else
      proxyBind(socket, reqInfo, self);
  });

  function onClose() {
    if (socket.dstSock && socket.dstSock.writable)
      socket.dstSock.end();
    socket.dstSock = undefined;
  }

  socket.on('error', onErrorNoop)
        .on('end', onClose)
        .on('close', onClose);
};

Server.prototype.useAuth = function(auth) {
  if (typeof auth !== 'object'
      || typeof auth.server !== 'function'
      || auth.server.length !== 2)
    throw new Error('Invalid authentication handler');
  else if (this._auths.length >= 255)
    throw new Error('Too many authentication handlers (limited to 255).');

  this._auths.push(auth);

  return this;
};

Server.prototype.listen = function() {
  this._srv.listen.apply(this._srv, arguments);
  return this;
};

Server.prototype.address = function() {
  return this._srv.address();
};

Server.prototype.getConnections = function(cb) {
  this._srv.getConnections(cb);
};

Server.prototype.close = function(cb) {
  this._srv.close(cb);
  return this;
};

Server.prototype.ref = function() {
  this._srv.ref();
};

Server.prototype.unref = function() {
  this._srv.unref();
};


exports.Server = Server;
exports.createServer = function(opts, listener) {
  return new Server(opts, listener);
};


function onErrorNoop(err) {}

function proxySocket(socket, req) {
  debug('proxySocket');
  dns.lookup(req.dstAddr, function(err, dstIP) {
    if (err) {
      handleProxyError(socket, err);
      return;
    }

    function onError(err) {
      if (!connected)
        handleProxyError(socket, err);
    }

    var dstSock = new net.Socket(),
        connected = false;

    dstSock.setKeepAlive(false);
    dstSock.on('error', onError)
           .on('connect', function() {
             connected = true;
             if (socket.writable) {
               writeResult(socket, dstSock.localAddress || '127.0.0.1', dstSock.localPort);
               socket.pipe(dstSock).pipe(socket);
               socket.resume();
             } else if (dstSock.writable)
               dstSock.end();
           })
           .connect(req.dstPort, dstIP);
    socket.dstSock = dstSock;
  });
}

function handleProxyError(socket, err) {
  debug('handleProxyError');
  if (socket.writable) {
    var errbuf = new Buffer([0x05, REP.GENFAIL]);
    if (err.code) {
      switch (err.code) {
        case 'ENOENT':
        case 'ENOTFOUND':
        case 'ETIMEDOUT':
        case 'EHOSTUNREACH':
          errbuf[1] = REP.HOSTUNREACH;
        break;
        case 'ENETUNREACH':
          errbuf[1] = REP.NETUNREACH;
        break;
        case 'ECONNREFUSED':
          errbuf[1] = REP.CONNREFUSED;
        break;
      }
    }
    socket.end(errbuf);
  }
}

function writeResult(socket, localAddress, localPort) {
  var localbytes = ipbytes(localAddress),
      len = localbytes.length,
      bufrep = new Buffer(6 + len),
      p = 4;
  bufrep[0] = 0x05;
  bufrep[1] = REP.SUCCESS;
  bufrep[2] = 0x00;
  bufrep[3] = (len === 4 ? ATYP.IPv4 : ATYP.IPv6);
  for (var i = 0; i < len; ++i, ++p)
    bufrep[p] = localbytes[i];
  bufrep.writeUInt16BE(localPort, p, true);

  socket.write(bufrep);

}

function randomIntFromInterval(min,max)
{
  return Math.floor(Math.random()*(max-min+1)+min);
}

function proxyBind(socket, req, server) {
  debug('proxyBind:' + JSON.stringify(req));
  var timeOut;
  var listenSock = new net.Server(),
      connected = false,
      port = req.dstPort == 0 ? randomIntFromInterval(server.minBindPort, server.maxBindPort) : req.dstPort;

  listenSock.on('error', function (e) {
    debug('listen error:'+e.code);
    if (e.code == 'EADDRINUSE') {
      listenSock.close();
      port = randomIntFromInterval(server.minBindPort, server.maxBindPort);
      listenSock.listen(port, server.bindHost);
    }
  }).on('listening', function() {
    var address = listenSock.address();
    debug('Listening on: '+address.address + ":" + address.port);
    writeResult(socket, address.address, address.port);
    timeOut = setTimeout(function() {
      var errbuf = new Buffer([0x05, REP.TTLEXPIRED]);
      socket.end(errbuf);
      listenSock.close();
    }, server.maxBindWait);
  }).on('connection', function(connectedSocket) {
    debug('Connection from: '+connectedSocket.remoteAddress + ":" + connectedSocket.remotePort);
    writeResult(socket, connectedSocket.remoteAddress, connectedSocket.remotePort);
    clearTimeout(timeOut);
    listenSock.close();
    connected=true;
    socket.pipe(connectedSocket);
    connectedSocket.pipe(socket);
    socket.on('close', function() {
      debug('close pipe sending')
    });
    connectedSocket.on('close', function() {
      debug('close pipe receiving')
    });
  });

  listenSock.listen(port, server.bindHost);

}
