module.exports = function(app) {

  require('./controllers/photos_controller')(app);

  require('./directives/photo_display_directive')(app);
  require('./directives/photo_form_directive')(app);//points to html template
};
