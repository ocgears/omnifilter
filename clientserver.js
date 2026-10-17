const express = require('express');
var cPort = process.env.CLIENTPORT || 5000;

// The built client on its own port (docker-compose.yml), with the same
// security headers as when the API serves it (server/lib/security_headers.js).
express()
  .disable('x-powered-by')
  .use(require(__dirname + '/server/lib/security_headers')(__dirname + '/dist/index.html'))
  .use(express.static(__dirname + '/dist'))
  .listen(cPort, () => console.log('Client server up on port ' + cPort + '.'));
