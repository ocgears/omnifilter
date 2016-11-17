module.exports = exports = {
  config: {
    // seleniumAddress: 'http://localhost:4444/wd/hub',
    directConnect: true,
    framework: 'jasmine',
    specs: ['e2e_start_spec.js']
    // ,
    // onPrepare: function() {
    //   require('babel-core/register');
    // }
  }
};
