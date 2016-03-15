module.exports = exports = function(err, res) {
  console.log('DB error : ' + err);
  res.status(500).json({ msg: 'Server Error' });
};
