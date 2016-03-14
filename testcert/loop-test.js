var tls = require('tls'),
    net = require('net'),
    fs = require('fs'),
    msg = [
        ".-..-..-.  .-.   .-. .--. .---. .-.   .---. .-.",
        ": :; :: :  : :.-.: :: ,. :: .; :: :   : .  :: :",
        ":    :: :  : :: :: :: :: ::   .': :   : :: :: :",
        ": :: :: :  : `' `' ;: :; :: :.`.: :__ : :; ::_;",
        ":_;:_;:_;   `.,`.,' `.__.':_;:_;:___.':___.':_;"
    ].join("\n");

var options = {
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.crt')
};

tls.createServer(options, function (s) {
    s.write(msg+"\n");
    s.pipe(s);
}).listen(8000);


var tls = require('tls');
var fs = require('fs');

var options = {rejectUnauthorized: false};

var sock = new net.Socket();
var client = new tls.TLSSocket(sock, options);
client.connect(8000, options, function () {
    console.log(client.authorized ? 'Authorized' : 'Not authorized');
    console.log(client.authorizationError);
});

client.on('data', function (data) {
    console.log(data.toString());
    client.end();
});