require(__dirname + '/../server.js');
const { clearCollections } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const sharp = require('sharp');

const chai = require('chai');
const { default: chaiHTTP, request } = require('chai-http');
chai.use(chaiHTTP);
const expect = chai.expect;

const PORT = process.env.PORT || process.env.$PORT || 3000;
const baseUri = 'localhost:' + PORT;

// The reply's body as bytes, whatever its type.
const binary = (req) => req.buffer(true).parse((res, done) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});

describe('sharing a photo by link', () => {
  let owner;
  let other;
  let photo;
  let jpeg;

  before(async () => {
    const users = await Promise.all(['share-owner@tester.com', 'share-other@tester.com'].map((email) => {
      const user = new User({ email: email });
      user.hashPassword('password3');
      return user.save();
    }));
    owner = users[0].generateToken();
    other = users[1].generateToken();
    jpeg = await sharp({ create: { width: 6, height: 4, channels: 3, background: '#c84' } }).jpeg().toBuffer();
    photo = await new Content({
      user_id: String(users[0]._id),
      tStack: [{ tOption: 'sepia', amount: 100, blend: 'normal' }, { tOption: 'vignette', amount: 60, blend: 'multiply' }],
      image: jpeg,
      mime: 'image/jpeg',
      width: 6,
      height: 4,
      thumb: 'data:image/webp;base64,AA==',
      createdAt: new Date('2026-10-21T12:00:00Z')
    }).save();
  });

  after(() => {
    delete process.env.OMNIFILTER_SHARING;
    return clearCollections();
  });

  const share = (token, id) => request.execute(baseUri).post('/content/' + (id || photo._id) + '/share')
    .set({ token: token });
  const unshare = (token) => request.execute(baseUri).delete('/content/' + photo._id + '/share')
    .set({ token: token });

  let shareId;

  it('is off until the owner asks for a link', async () => {
    const res = await request.execute(baseUri).get('/getAll').set({ token: owner });
    expect(res.body[0]).to.not.have.property('shareId');
  });

  it('gives the owner a random link, the same one each time', async () => {
    const res = await share(owner);
    expect(res).to.have.status(200);
    shareId = res.body.shareId;
    expect(shareId).to.match(/^[A-Za-z0-9_-]{22}$/);
    expect((await share(owner)).body.shareId).to.equal(shareId);
    // The gallery says it's shared.
    const all = await request.execute(baseUri).get('/getAll').set({ token: owner });
    expect(all.body[0].shareId).to.equal(shareId);
  });

  it('gives no one else a link to it', async () => {
    expect(await share(other)).to.have.status(404);
    expect(await unshare(other)).to.have.status(404);
    expect(await request.execute(baseUri).post('/content/' + photo._id + '/share')).to.have.status(401);
    expect(await share(owner, 'not-an-id')).to.have.status(404);
  });

  it('shows anyone the photo on a page, with a preview for chat apps', async () => {
    const res = await request.execute(baseUri).get('/p/' + shareId);
    expect(res).to.have.status(200);
    expect(res).to.be.html;
    expect(res.headers['x-robots-tag']).to.equal('noindex');
    expect(res.headers['cache-control']).to.equal('no-cache');
    expect(res.text).to.include('<title>Sepia + Vignette · OmniFilter</title>');
    expect(res.text).to.include('<meta name="robots" content="noindex">');
    expect(res.text).to.include('<img src="/p/' + shareId + '/photo" width="6" height="4"');
    expect(res.text).to.include('Sepia + Vignette, made with OmniFilter on 21 October 2026.');
    expect(res.text).to.match(new RegExp('<meta property="og:image" content="http://' + baseUri.replace('.', '\\.') +
      '/p/' + shareId + '/photo">'));
    // No scripts, and the usual Content Security Policy.
    expect(res.text).to.not.include('<script');
    expect(res.headers['content-security-policy']).to.include('script-src \'self\'');
  });

  it('sends anyone the photo itself', async () => {
    const res = await binary(request.execute(baseUri).get('/p/' + shareId + '/photo'));
    expect(res).to.have.status(200);
    expect(res.headers['content-type']).to.match(/^image\/jpeg/);
    expect(res.headers['content-disposition']).to.match(/^inline; filename="omnifilter-[\w-]{6}\.jpg"$/);
    expect(Buffer.compare(res.body, jpeg)).to.equal(0);
  });

  it('answers a made-up or malformed address with a page saying it isn\'t shared', async () => {
    for (const id of ['AAAAAAAAAAAAAAAAAAAAAA', 'short', '%3Cscript%3E']) {
      const res = await request.execute(baseUri).get('/p/' + id);
      expect(res).to.have.status(404);
      expect(res.text).to.include('This photo isn\'t shared');
      expect(res.headers['cache-control']).to.equal('no-store');
      expect(await request.execute(baseUri).get('/p/' + id + '/photo')).to.have.status(404);
    }
  });

  it('turns everything off with OMNIFILTER_SHARING=off', async () => {
    process.env.OMNIFILTER_SHARING = 'off';
    try {
      expect(await share(owner)).to.have.status(403);
      expect(await request.execute(baseUri).get('/p/' + shareId)).to.have.status(404);
      expect(await request.execute(baseUri).get('/p/' + shareId + '/photo')).to.have.status(404);
      expect((await request.execute(baseUri).get('/settings')).body.sharing).to.equal(false);
    } finally {
      delete process.env.OMNIFILTER_SHARING;
    }
    expect((await request.execute(baseUri).get('/settings')).body.sharing).to.equal(true);
  });

  it('stops working when the owner stops sharing, and a new link is a new address', async () => {
    expect(await unshare(owner)).to.have.status(200);
    expect(await request.execute(baseUri).get('/p/' + shareId)).to.have.status(404);
    expect(await request.execute(baseUri).get('/p/' + shareId + '/photo')).to.have.status(404);
    const again = await share(owner);
    expect(again.body.shareId).to.not.equal(shareId);
    shareId = again.body.shareId;
  });

  it('goes with the photo when it is deleted', async () => {
    expect(await request.execute(baseUri).delete('/delete/' + photo._id).set({ token: owner }))
      .to.have.status(200);
    expect(await request.execute(baseUri).get('/p/' + shareId)).to.have.status(404);
  });
});
