module.exports = exports = function(err, res) {
  console.log('DB error : ' + err);
  return res.status(500).json({ msg: 'Server Error' });
};
