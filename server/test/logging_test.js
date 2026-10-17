const expect = require('chai').expect;
const logging = require(__dirname + '/../lib/cloud_logging');

describe('logging on Cloud Run (lib/cloud_logging.js)', () => {
  const lines = [];
  const out = { write: (line) => lines.push(JSON.parse(line)) };
  beforeEach(() => { lines.length = 0; });

  it('writes each message as one JSON entry, a stack trace and all', () => {
    logging.writer('INFO', out)('Unexpected error: ', new Error('boom'));
    expect(lines).to.have.length(1);
    expect(lines[0].severity).to.eql('ERROR');
    expect(lines[0].message).to.match(/^Unexpected error: {2}Error: boom\n {4}at /);
  });

  it('marks warnings, and keeps the rest at the console method\'s level', () => {
    logging.writer('INFO', out)('WARNING: image filters will fail: %s', 'no device');
    logging.writer('INFO', out)('Omnifilter backend server up on port: 8080');
    logging.writer('ERROR', out)('Live preview:', 'lost');
    expect(lines.map((l) => [l.severity, l.message])).to.eql([
      ['WARNING', 'WARNING: image filters will fail: no device'],
      ['INFO', 'Omnifilter backend server up on port: 8080'],
      ['ERROR', 'Live preview: lost']
    ]);
  });
});
