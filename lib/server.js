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
    //debug('server tls:'+JSON.stringify(options.tls));
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
  this.maxBindWait = options && options.maxBindWait || 60000;
  this.noDelay = options && options.noDelay || false;
  this.logger = options && options.logger || undefined;

}
inherits(Server, EventEmitter);

Server.prototype._onConnection = function(socket) {
  var self = this,
      authObj = undefined,
      parser = new Parser(socket);
  socket.setNoDelay(self.noDelay);
  parser.on('error', function(err) {
    if (socket.writable)
      socket.end();
  }).on('methods', function(methods) {
    var auths = self._auths;
    for (var a = 0, alen = auths.length; a < alen; ++a) {
      for (var m = 0, mlen = methods.length; m < mlen; ++m) {
        if (methods[m] === auths[a].METHOD) {
          auths[a].server(socket, function(result, _authObj) {
            if (result === true) {
              parser.authed = true;
              authObj = _authObj;
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
    if (reqInfo.cmd !== 'connect' && reqInfo.cmd !== 'bind') {
      if (self.logger)
        logger.error('Wrong command:'+reqInfo.cmd+' from:'+socket.remoteAddress+':'+socket.remotePort);
      return socket.end(BUF_REP_CMDUNSUPP);
    }

    reqInfo.srcAddr = socket.remoteAddress;
    reqInfo.srcPort = socket.remotePort;
    reqInfo.authObj = authObj;

    var handled = false;

    function accept(intercept, force) {
      debug('accept intercept:'+intercept);
      if (handled && (force === undefined || !force))
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
            proxySocket(socket, reqInfo, self);
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
      proxySocket(socket, reqInfo, self);
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

Server.prototype.loginfo = function(message) {
  if (this.logger) {
    this.logger.info(message)
  }
}

exports.Server = Server;
exports.createServer = function(opts, listener) {
  return new Server(opts, listener);
};


function onErrorNoop(err) {}

function proxySocket(socket, req, server) {
  if (server.logger)
    server.logger.debug('Connecting to ' + JSON.stringify(req))
  server.loginfo('Connecting to ' + req.dstAddr + ':' + req.dstPort + ' (from = ' + req.srcAddr + ':' + req.srcPort + ') (user = ' + req.authObj.user + ')')
  dns.lookup(req.dstAddr, function(err, dstIP) {
    if (err) {
      handleProxyError(socket, err, server);
      return;
    }

    function onError(err) {
      if (!connected)
        handleProxyError(socket, err, server);
    }

    var dstSock = new net.Socket(),
        connected = false;

    dstSock.setKeepAlive(false);
    dstSock.on('error', onError)
           .on('connect', function() {
             connected = true;
             dstSock.setNoDelay(server.noDelay);
             if (socket.writable) {
              writeResult(socket, dstSock.localAddress || '127.0.0.1', dstSock.localPort);
              socket.pipe(dstSock).on('close', function(hadError) {
                server.loginfo(req.cmd + ' Client -> Server closed. (port = ' + req.dstPort + ') (user = ' + req.authObj.user + ') (err = ' + hadError + ')')
              }).on('error', function(err) {
                server.loginfo(req.cmd + ' Client -> Server error = ' + JSON.stringify(err))
              });

              dstSock.pipe(socket).on('close', function(hadError) {
                server.loginfo(req.cmd + ' internal -> Server closed. (port = '+ req.dstPort + ') (user = ' + req.authObj.user + ') (err = ' + hadError + ')')
              }).on('error', function(err) {
                server.loginfo(req.cmd + ' internal -> Server error = ' + JSON.stringify(err))
              });
   
              socket.resume();
             } else if (dstSock.writable)
               dstSock.end();
           })
           .connect(req.dstPort, dstIP);
    socket.dstSock = dstSock;
  });
}

function handleProxyError(socket, err, server) {
  if (server.logger)
    server.logger.error('Error:'+JSON.stringify(err)+' from:'+socket.remoteAddress+':'+socket.remotePort);
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
  if (server.logger)
    server.logger.debug('Bind to:'+JSON.stringify(req)+' from:'+socket.remoteAddress+':'+socket.remotePort);
  var timeOut;
  var listenSock = new net.Server(),
      connected = false,
      port = req.dstPort == 0 ? randomIntFromInterval(server.minBindPort, server.maxBindPort) : req.dstPort;

  if (typeof req.authObj != "undefined" && typeof req.authObj.bindPort != "undefined") {
    port = req.authObj.bindPort;
  }

  listenSock.on('error', function (e) {
    if (server.logger)
      server.logger.error('Bind to:'+JSON.stringify(req)+' from:'+socket.remoteAddress+':'+socket.remotePort+' listen error:'+e.code);
    if (e.code == 'EADDRINUSE') {
      listenSock.close()
      if (req.authObj.onBindPortError !== undefined) {
        let nRetry = req.authObj.bindPortRetry === undefined ? 0 : req.authObj.bindPortRetry
        if (nRetry < 3) {
          req.authObj.onBindPortError(e)

        } else {
          if (server.logger)
            server.logger.error("reached max Bind retry ...")
          socket.end()  //NB: consente la chiusura del socket operatore in listen!
        }

      } else {
        port = randomIntFromInterval(server.minBindPort, server.maxBindPort);
        listenSock.listen(port, server.bindHost);
      }
    }
  }).on('listening', function() {
    var address = listenSock.address();
    server.loginfo('Bind on ' + address.address + ":" + address.port + ' (from = ' + socket.remoteAddress + ':' + socket.remotePort + ') (user = ' + req.authObj.user + ')')
    writeResult(socket, address.address, address.port);
    timeOut = setTimeout(function() {
      var errbuf = new Buffer([0x05, REP.TTLEXPIRED]);
      server.loginfo('Bind to: '+address.address + ":" + address.port+' end for timeout');
      socket.end(errbuf);
      listenSock.close();
    }, server.maxBindWait);
  }).on('connection', function(connectedSocket) {
    if (server.logger)
      server.logger.debug('Connected to ' + JSON.stringify(req))
    server.loginfo('Connected to ' + req.dstAddr + ':' + req.authObj.bindPort + ' (from = ' + connectedSocket.remoteAddress + ':' + connectedSocket.remotePort + ') (user = ' + req.authObj.user + ')');
    writeResult(socket, connectedSocket.remoteAddress, connectedSocket.remotePort);
    clearTimeout(timeOut);
    listenSock.close();
    connected=true;
    connectedSocket.setNoDelay(server.noDelay);
    socket.pipe(connectedSocket);
    connectedSocket.pipe(socket);
    socket.on('close', function(hadError) {
      debug('close pipe sending')
      server.loginfo(req.cmd + ' Operator -> Server closed. (port = ' + req.authObj.bindPort + ') (user = ' + req.authObj.user + ') (err = ' + hadError + ')')
    }).on('error', function(err) {
      server.loginfo(req.cmd + ' Operator -> Server error = ' + JSON.stringify(err))
    });

    connectedSocket.on('close', function(hadError) {
      debug('close pipe receiving')
      server.loginfo(req.cmd + ' internal -> Server closed. (port = ' + req.authObj.bindPort + ') (user = ' + req.authObj.user + ') (err = ' + hadError + ')')
    }).on('error', function(err) {
      server.loginfo(req.cmd + ' internal -> Server error = ' + JSON.stringify(err))
    });
  });

  listenSock.listen(port, server.bindHost);

}
