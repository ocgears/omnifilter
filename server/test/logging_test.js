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

describe('logging under a request (lib/cloud_logging.js)', () => {
  it('marks what a request logs with its trace, and nothing else', (done) => {
    const lines = [];
    const log = logging.writer('INFO', { write: (line) => lines.push(JSON.parse(line)) });
    const middleware = logging.middleware('my-project');
    const req = { get: () => '0123456789ABCDEF0123456789abcdef/42;o=1' };
    middleware(req, {}, () => {
      setTimeout(() => {
        log('during the request');
        expect(lines[0]['logging.googleapis.com/trace'])
          .to.equal('projects/my-project/traces/0123456789abcdef0123456789abcdef');
        log('still during it');
        expect(lines).to.have.length(2);
        done();
      });
    });
    log('outside any request');
    expect(lines[0]).to.not.have.property('logging.googleapis.com/trace');
    lines.length = 0;
  });
});
