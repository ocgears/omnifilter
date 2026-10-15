// The install script names prebuilt binaries by a hash of the native source.
const expect = require('chai').expect;
const install = require(__dirname + '/../../scripts/install-native');

describe('installing the native addon', () => {
  it('keys prebuilt binaries by the native source', () => {
    const key = install.sourceKey();
    expect(key).to.match(/^[0-9a-f]{16}$/);
    expect(install.sourceKey()).to.equal(key);
  });

  it('names a binary by its key and platform', () => {
    expect(install.assetName('0123456789abcdef', 'win32-arm64')).to.equal('omnifilter-0123456789abcdef-win32-arm64.node');
  });
});
