module.exports = function(app) {
  require('./controllers/omnifilter_controller')(app);

  require('./directives/omnifilter_display_directive')(app);
  require('./directives/omnifilter_form_directive')(app);
};
