/*eslint-disable*/
describe('Omnifilter App UI basic elements', function() {
  it('should have a title', function() {
    browser.get('http://localhost:5000/');

    expect(browser.getTitle()).toEqual('OmniFilter');
  });
  
  it('should have a copyright statement', function() {
    element(by.css('footer')).getText(function(text) {
      expect(text).toEqual('Copyright 2016 Omnifilter');
    });
  });
});
