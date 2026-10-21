module.exports = exports = function(err, res) {
  console.log('DB error : ' + err);
  return res.status(500).json({ msg: 'Something went wrong on the server. Try again in a moment.' });
};
