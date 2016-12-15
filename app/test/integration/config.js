module.exports = exports = {
  config: {
    seleniumAddress: 'http://localhost:4444/wd/hub',
    // directConnect: true,
    framework: 'jasmine',
    specs: ['basic_ui_test.js'],
    multiCapabilities:
      [ { browserName: 'firefox' },
      { browserName: 'chrome'
    }]
  }
};
