module.exports = function(app) {

  require('./controllers/photos_controller')(app);

  require('./directives/photo_display_directive')(app);
};
