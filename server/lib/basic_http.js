const zeroBuffer = require(__dirname + '/zero_buffer');

module.exports = exports = (req, res, next) => {
  try {
    var authString = req.headers.authorization;
    var base64String = authString.split(' ')[1];
    var authBuf = new Buffer(base64String, 'base64');
    var utf8AuthString = authBuf.toString();
    var authArr = utf8AuthString.split(':');

    zeroBuffer(authBuf);
    if (authArr[0].length && authArr[1].length) {
      req.basicHTTP = {
        email: authArr[0],
        password: authArr[1]
      };
      return next();
    }
  } catch (e) {
    console.log('basic http error : ' + e);
  }
  res.status(401).json({ msg: 'could not authenticate user' });
};
