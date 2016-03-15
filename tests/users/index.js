module.exports = function(app) {
  require('./controllers/users_controller')(app);

  require('./directives/user_display_directive')(app);
  require('./directives/user_form_directive')(app);
};
