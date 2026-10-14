module.exports = function(app) {
  require('./api_base')(app);
  require('./resource_service')(app);
};
