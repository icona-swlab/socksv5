var debug = require('debug')('test-client');

var auth = require('../index').auth,
    createServer = require('../index').createServer,
    connect = require('../index').connect,
    bind = require('../index').bind,
    ETTLEXPIRED = 'ETTLEXPIRED';

var path = require('path'),
    fs = require('fs'),
    assert = require('assert');

var t = -1,
    group = path.basename(__filename, '.js') + '/';

var PROXY_RESPONSE = 'nice to meet you! ;-)';
var PROXY_HELLO = 'hello from the node.js proxy server!';

var tests = [
 { run: function() {
    var what = this.what,
        conns = 0,
        sended,
        response,
        server;
   var serverOptions = {
     tls: {
       cert: fs.readFileSync('testcert/server.crt'),
       key: fs.readFileSync('testcert/server.key')
     }
   };

    server = createServer(serverOptions, function(info, accept) {
      accept();
    });

    server.useAuth(auth.None());
    server.maxBindWait = 3000;

    server.listen(0, 'localhost', function() {
      debug('Listening on :' + server.address().port);
      bind({
        host: '192.168.0.158',
        port: 0,
        proxyHost: 'localhost',
        proxyPort: server.address().port,
        tls: {rejectUnauthorized: false}
      }, function(socket, server, port) {
        debug('Writing to socket');
        socket.setEncoding('ascii');
        socket.on('data', function(data) {
          sended = data;
          debug('received :' + data);
          socket.end(PROXY_RESPONSE, 'ascii');
        })
      }).useAuth(auth.UserPassword('nodejsb', 'rules')
      ).on('error', function(err) {
        assert(false, makeMsg(what, 'Unexpected error: ' + err));
      }).on('close', function() {
      }
      ).on('bind', function(socket, bserver, bport) {
        debug('bind on:'+bserver + ':' + bport);

        connect({
          host: bserver,
          port: bport,
          proxyHost: 'localhost',
          proxyPort: server.address().port,
          tls: {rejectUnauthorized: false}
        }, function(socket, server, port) {
          debug('Connected to:'+bserver + ':' + bport);
          conns++;
          socket.write(PROXY_HELLO, 'ascii');
          bufferStream(socket, 'ascii', function(data) {
            response = data;
            debug('received :' + data);
          });
        }).on('error', function(err) {
          assert(false, makeMsg(what, 'Unexpected error: ' + err));
        }).on('close', function() {
          debug('close conns:' + conns);
          server.close();
          // allow bufferStream() callback to be called first
          process.nextTick(function() {
            assert(sended === PROXY_HELLO,
                makeMsg(what, 'Sent mismatch'));
            assert(response === PROXY_RESPONSE,
                makeMsg(what, 'Response mismatch'));
            assert(conns === 1,
                makeMsg(what, 'Wrong number of connections'));
            next();
          });
        }).useAuth(auth.UserPassword('nodejsc', 'rules'));
      });
    }).useAuth(auth.UserPassword(function(user, pass, cb) {
      debug('Auth:'+user+' '+pass);
      cb(user.startsWith('nodejs') && pass.startsWith('rules'),{bindPort: 44444});
    })).on('connection', function(connInfo, accept, deny) {
      debug('Connection for:'+JSON.stringify(connInfo));
      accept();
    });
  },
    what: 'bind send/receive ssl port'
  },
];

function bufferStream(stream, encoding, cb) {
  var buf;
  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = undefined;
  }
  if (!encoding) {
    var nb = 0;
    stream.on('data', function(d) {
      if (nb === 0)
        buf = [ d ];
      else
        buf.push(d);
      nb += d.length;
    }).on((stream.writable ? 'close' : 'end'), function() {
      cb(nb ? Buffer.concat(buf, nb) : buf);
    });
  } else {
    stream.on('data', function(d) {
      if (!buf)
        buf = d;
      else
        buf += d;
    }).on((stream.writable ? 'close' : 'end'), function() {
      cb(buf);
    }).setEncoding(encoding);
  }
}

function next() {
  if (t === tests.length - 1)
    return;
  var v = tests[++t];
  console.log(v.what);
  v.run.call(v);
}

function makeMsg(what, msg) {
  return '[' + group + what + ']: ' + msg;
}

process.once('uncaughtException', function(err) {
  if (t > -1 && !/(?:^|\n)AssertionError: /i.test(''+err))
    console.log(makeMsg(tests[t].what, 'Unexpected Exception:'));

  throw err;
});
process.once('exit', function() {
  assert(t === tests.length - 1,
         makeMsg('_exit',
                 'Only finished ' + (t + 1) + '/' + tests.length + ' tests'));
});

next();