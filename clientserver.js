const express = require('express');
var cPort = process.env.CLIENTPORT || 5000;

express().use(express.static(__dirname + '/dist'))
  .listen(cPort, () => console.log('Client server up on port ' + cPort + '.'));
