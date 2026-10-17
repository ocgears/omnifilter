// The install script names prebuilt binaries by a hash of the native source.
const expect = require('chai').expect;
const install = require(__dirname + '/../../scripts/install-native');

describe('installing the native addon', () => {
  it('keys prebuilt binaries by the native source', () => {
    const key = install.sourceKey();
    expect(key).to.match(/^[0-9a-f]{16}$/);
    expect(install.sourceKey()).to.equal(key);
  });

  it('trusts only the checksums listed in the repository', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilds-')), 'prebuilds.json');
    const sum = 'ab'.repeat(32);
    fs.writeFileSync(file, JSON.stringify({ checksums: { k1: { 'linux-x64': sum, 'darwin-arm64': 'nope' } } }));
    expect(install.expectedChecksum('k1', 'linux-x64', file)).to.equal(sum);
    expect(install.expectedChecksum('k1', 'darwin-arm64', file)).to.equal(null);
    expect(install.expectedChecksum('k2', 'linux-x64', file)).to.equal(null);
    expect(install.expectedChecksum('k1', 'linux-x64', file + '.missing')).to.equal(null);
  });

  it('names a binary by its key and platform', () => {
    expect(install.assetName('0123456789abcdef', 'win32-arm64')).to.equal('omnifilter-0123456789abcdef-win32-arm64.node');
  });
});
