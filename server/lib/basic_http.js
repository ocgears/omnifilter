const zeroBuffer = require(__dirname + '/zero_buffer');

module.exports = exports = (req, res, next) => {
  try {
    var authString = req.headers.authorization;
    var base64String = authString.split(' ')[1];
    var authBuf = Buffer.from(base64String, 'base64');
    var utf8AuthString = authBuf.toString();
    // Emails can't contain a colon but passwords can, so split at the first.
    var colon = utf8AuthString.indexOf(':');

    zeroBuffer(authBuf);
    if (colon > 0 && colon < utf8AuthString.length - 1) {
      req.basicHTTP = {
        email: utf8AuthString.slice(0, colon),
        password: utf8AuthString.slice(colon + 1)
      };
      return next();
    }
  } catch (e) {
    console.log('basic http error : ' + e);
  }
  res.status(401).json({ msg: 'could not authenticate user' });
};
