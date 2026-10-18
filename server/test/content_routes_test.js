require(__dirname + '/../server.js');
const { clearCollections, keptPhoto } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const imageCodec = require(__dirname + '/../lib/image_codec');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var { default: chaiHTTP, request } = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;
const sharp = require('sharp');

const pngDataUrl = () =>
  sharp({ create: { width: 4, height: 3, channels: 4, background: '#08f8' } })
    .png().toBuffer().then((bytes) => 'data:image/png;base64,' + bytes.toString('base64'));

describe('content API', () => {

  var userToken;
  var userId;

  before((done) => {
    var newUser = new User();
    newUser.email = 'test2@tester.com';
    newUser.hashPassword('password2');
    newUser.save().then((data) => {
      userToken = data.generateToken();
      userId = data._id;
      done();
    }, done);
  });

  after((done) => {
    clearCollections().then(() => done(), done);
  });

  it('should be able to GET all content', (done) => {
    request.execute(baseUri)
      .get('/getAll')
      .set( { token: userToken } )
      .end((err, res) => {
        expect(err).to.eql(null);
        expect(res.body).to.not.eql(null);
        done();
      });
  });

  it('should create content with a POST', () => {
    return pngDataUrl().then((content) => request.execute(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: content } )
      .then((res) => {
        expect(res).to.have.status(200);
        expect(res.body).to.have.property('_id');
        expect(res.body).to.include({ mime: 'image/png', width: 4, height: 3 });
        expect(res.body.thumb).to.match(/^data:image\/webp;base64,/);
        expect(res.body).to.not.have.property('content');
        expect(res.body).to.not.have.property('image');
        return keptPhoto(baseUri, userToken, res.body._id);
      })
      .then((kept) => expect(kept).to.eql(content)));
  });

  it('labels a photo saved as is with the format it really is', () => {
    return pngDataUrl().then((content) => request.execute(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: content.replace('image/png', 'image/jpeg') } )
      .then((res) => {
        expect(res).to.have.status(200);
        return keptPhoto(baseUri, userToken, res.body._id);
      })
      .then((kept) => expect(kept).to.eql(content)));
  });

  it('refuses to save something that only claims to be an image', () => {
    return request.execute(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: 'data:image/png;base64,AAAA' } )
      .then((res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.eql('Unsupported or corrupt image');
      });
  });

  it('refuses to save an SVG sent as a JPEG', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
    return request.execute(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: 'data:image/jpeg;base64,' + Buffer.from(svg).toString('base64') } )
      .then((res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.match(/Unsupported or corrupt image/);
        return Content.countDocuments({ user_id: userId, content: /svg/ });
      })
      .then((count) => expect(count).to.eql(0));
  });

  it('refuses to save a photo too large to store', () => {
    const limit = imageCodec.MAX_DATA_URL_LENGTH;
    imageCodec.MAX_DATA_URL_LENGTH = 50;
    return pngDataUrl().then((content) => request.execute(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: content } ))
      .then((res) => {
        expect(res).to.have.status(413);
        expect(res.body.msg).to.match(/too large/);
      })
      .finally(() => { imageCodec.MAX_DATA_URL_LENGTH = limit; });
  });

  it('moves a photo kept as a data URL to the new fields, once, and still sends it', async () => {
    const content = await pngDataUrl();
    const old = await Content.collection.insertOne({ user_id: String(userId), content: content, tOption: 'invert',
      createdAt: new Date() });
    const list = await request.execute(baseUri).get('/getAll').set({ token: userToken });
    const listed = list.body.find((p) => p._id === String(old.insertedId));
    expect(listed).to.include({ mime: 'image/png', width: 4, height: 3 });
    expect(listed.thumb).to.match(/^data:image\/webp;base64,/);
    const saved = await Content.collection.findOne({ _id: old.insertedId });
    expect(saved).to.not.have.property('content');
    expect(Buffer.from(saved.image.buffer).toString('base64')).to.eql(content.split(',')[1]);
    expect(await keptPhoto(baseUri, userToken, old.insertedId)).to.eql(content);
  });

  it('pages through the photos, newest first, and says how many there are', async () => {
    const pager = new User();
    pager.email = 'pager@tester.com';
    pager.hashPassword('password5');
    const saved = await pager.save();
    const token = saved.generateToken();
    const made = new Date('2026-10-10T00:00:00Z');
    // Five photos, two made at the same moment.
    await Content.insertMany([0, 1, 2, 2, 3].map((n) => ({ user_id: String(saved._id),
      image: Buffer.from('x'), mime: 'image/png', createdAt: new Date(made.getTime() + n * 1000) })));
    const page = (query) => request.execute(baseUri).get('/getAll' + query).set({ token: token });
    const first = await page('?limit=2');
    expect(first).to.have.header('omnifilter-total', '5');
    expect(first.body).to.have.length(2);
    const second = await page('?limit=2&before=' + first.body[1]._id);
    const third = await page('?limit=2&before=' + second.body[1]._id);
    const ids = first.body.concat(second.body, third.body).map((p) => p._id);
    expect(new Set(ids).size).to.equal(5);
    const all = (await page('')).body.map((p) => p._id);
    expect(ids).to.eql(all);
    expect(await page('?before=nope')).to.have.status(400);
  });

  it('sends a photo kept as a data URL only if it was kept as a photo type', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const old = await Content.collection.insertOne({ user_id: String(userId), tOption: 'invert',
      content: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), createdAt: new Date() });
    expect(await request.execute(baseUri).get('/content/' + old.insertedId).set({ token: userToken }))
      .to.have.status(404);
    await Content.deleteOne({ _id: old.insertedId });
  });

  it('sends a photo as a file to save, and only to its owner', async () => {
    const made = await request.execute(baseUri).post('/newcontent').set({ token: userToken })
      .send({ content: await pngDataUrl() });
    const id = made.body._id;
    const download = await request.execute(baseUri).get('/content/' + id + '?download=my-photo.png')
      .set({ token: userToken });
    expect(download).to.have.status(200);
    expect(download).to.have.header('content-type', 'image/png');
    expect(download).to.have.header('content-disposition', 'attachment; filename="my-photo.png"');
    expect(download).to.have.header('cache-control', 'private, no-store');
    const odd = await request.execute(baseUri).get('/content/' + id + '?download=../../etc"x').set({ token: userToken });
    expect(odd.headers['content-disposition']).to.match(/^attachment; filename="omnifilter-\w{6}\.png"$/);
    expect(await request.execute(baseUri).get('/content/' + id)).to.have.status(401);
    const other = new User();
    other.email = 'someone-else@tester.com';
    other.hashPassword('password3');
    const otherToken = (await other.save()).generateToken();
    expect(await request.execute(baseUri).get('/content/' + id).set({ token: otherToken })).to.have.status(404);
    expect(await request.execute(baseUri).get('/content/nope').set({ token: userToken })).to.have.status(404);
  });

  describe('rest requests that require content already in db', () => {
    beforeEach((done) => {
      Content.create( { content: 'test content', user_id: userId }).then((data) => {
        this.testContent = data;
        done();
      }, done);
    });

    it('should be able to delete content', (done) => {
      request.execute(baseUri)
        .delete('/delete/' + this.testContent._id)
        .set( { token: userToken } )
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body.msg).to.eql('Successfully deleted content');
          done();
        });
    });
  });
});
