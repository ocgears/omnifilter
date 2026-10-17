require(__dirname + '/../server.js');
const { clearCollections, keptPhoto } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const contentRouter = require(__dirname + '/../routes/content_routes');
const settings = require(__dirname + '/../lib/settings');
const sharp = require('sharp');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var { default: chaiHTTP, request } = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;

const KEYS = ['OMNIFILTER_MODE', 'OMNIFILTER_PROCESSING', 'OMNIFILTER_GUESTS', 'OMNIFILTER_MAX_STORED_PHOTOS',
  'OMNIFILTER_KEEP_MAX_SIDE'];

describe('the server settings (lib/settings.js)', () => {
  it('filters on the server for everyone by default, and keeps any number of photos', () => {
    expect(settings.read({})).to.eql({
      mode: 'standard', processing: 'server', guests: 'server', maxStoredPhotos: null, keepMaxSide: null
    });
  });

  it('in cloud mode, filters on the visitor\'s device and keeps 5 photos each', () => {
    expect(settings.read({ OMNIFILTER_MODE: 'cloud' })).to.eql({
      mode: 'cloud', processing: 'device', guests: 'device', maxStoredPhotos: 5, keepMaxSide: 2048
    });
  });

  it('lets each cloud setting be changed on its own', () => {
    expect(settings.read({
      OMNIFILTER_MODE: 'Cloud', OMNIFILTER_PROCESSING: 'device-first', OMNIFILTER_GUESTS: 'off',
      OMNIFILTER_MAX_STORED_PHOTOS: '12', OMNIFILTER_KEEP_MAX_SIDE: '4096'
    })).to.eql({ mode: 'cloud', processing: 'device-first', guests: 'off', maxStoredPhotos: 12, keepMaxSide: 4096 });
  });

  it('reads the old on and off values for guests, and ignores nonsense', () => {
    expect(settings.read({ OMNIFILTER_GUESTS: 'no' }).guests).to.eql('off');
    expect(settings.read({ OMNIFILTER_GUESTS: 'on' }).guests).to.eql('server');
    expect(settings.read({ OMNIFILTER_PROCESSING: 'gpu', OMNIFILTER_MAX_STORED_PHOTOS: '-3' }))
      .to.include({ processing: 'server', maxStoredPhotos: null });
  });
});

describe('cloud mode on the server', () => {
  var token;
  var photo;
  const saved = {};

  before(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    const user = new User();
    user.email = 'cloud-mode@tester.com';
    user.hashPassword('password4');
    return Promise.all([
      user.save(),
      sharp({ create: { width: 8, height: 6, channels: 3, background: '#406080' } }).jpeg().toBuffer()
    ]).then(([u, bytes]) => {
      token = u.generateToken();
      photo = 'data:image/jpeg;base64,' + bytes.toString('base64');
    });
  });

  beforeEach(() => {
    process.env.OMNIFILTER_MODE = 'cloud';
    contentRouter.guestLimiter.reset();
  });

  after(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    return clearCollections();
  });

  it('tells the page', () => {
    return request.execute(baseUri).get('/settings').then((res) => {
      expect(res).to.have.status(200);
      expect(res.body).to.include({ mode: 'cloud', processing: 'device', guests: 'device', maxStoredPhotos: 5 });
      expect(res.body.maxPixels).to.be.above(0);
    });
  });

  it('has no device to set up or report', () => {
    expect(settings.serverDevice(settings.read({ OMNIFILTER_MODE: 'cloud' }))).to.eql(false);
    expect(settings.serverDevice(settings.read({}))).to.eql(true);
    expect(settings.serverDevice(settings.read({ OMNIFILTER_MODE: 'cloud', OMNIFILTER_GUESTS: 'server' })))
      .to.eql(true);
    return request.execute(baseUri).get('/device').then((res) => {
      expect(res).to.have.status(200);
      expect(res.body).to.eql(null);
    });
  });

  it('runs no filters for guests', () => {
    return request.execute(baseUri).post('/transform').send({ content: photo, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(403);
        expect(res.body.msg).to.match(/run on your own device/);
      });
  });

  it('runs no filters for signed-in users, but keeps photos as they are', () => {
    return request.execute(baseUri).post('/newcontent').set({ token: token })
      .send({ content: photo, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(403);
        return request.execute(baseUri).post('/newcontent').set({ token: token }).send({ content: photo });
      })
      .then((res) => expect(res).to.have.status(200))
      .then(() => Content.deleteMany({}));
  });

  it('keeps 5 photos for each account, then refuses more until one is deleted', async () => {
    const keep = () => request.execute(baseUri).post('/import').set({ token: token })
      .send({ content: photo, tOption: 'invert' });
    for (let n = 0; n < 5; n++) expect(await keep()).to.have.status(200);
    const refused = await keep();
    expect(refused).to.have.status(409);
    expect(refused.body).to.include({ limit: 5 });
    expect(refused.body.msg).to.match(/already keep 5 photos/);
    // Saving the photo as it is counts too.
    expect(await request.execute(baseUri).post('/newcontent').set({ token: token }).send({ content: photo }))
      .to.have.status(409);

    const one = await Content.findOne({});
    expect(await request.execute(baseUri).delete('/delete/' + one._id).set({ token: token })).to.have.status(200);
    expect(await keep()).to.have.status(200);
    await Content.deleteMany({});
  });

  it('keeps to the limit when many photos are sent at once', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      request.execute(baseUri).post('/import').set({ token: token }).send({ content: photo, tOption: 'invert' })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).to.be.at.most(5);
    expect(statuses.every((s) => [200, 409, 429, 503].includes(s))).to.eql(true);
    expect(await Content.countDocuments({})).to.be.at.most(5);
    await Content.deleteMany({});
  });

  it('keeps a smaller copy of a big photo, and a thumbnail', async () => {
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#406080' } })
      .png().toBuffer();
    const res = await request.execute(baseUri).post('/import').set({ token: token })
      .send({ content: 'data:image/png;base64,' + big.toString('base64'), tOption: 'invert' });
    expect(res).to.have.status(200);
    expect(res.body).to.include({ width: 2048, height: 1024, mime: 'image/jpeg' });
    const kept = await keptPhoto(baseUri, token, res.body._id);
    const meta = await sharp(Buffer.from(kept.split(',')[1], 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).to.eql(['jpeg', 2048, 1024]);
    const thumb = await sharp(Buffer.from(res.body.thumb.split(',')[1], 'base64')).metadata();
    expect([thumb.format, thumb.width, thumb.height]).to.eql(['webp', 640, 320]);
    // The gallery's list has the thumbnail, not the photo.
    const list = await request.execute(baseUri).get('/getAll').set({ token: token });
    expect(list.body).to.have.length(1);
    expect(list.body[0]).to.include({ thumb: res.body.thumb, width: 2048 });
    expect(list.body[0]).to.not.have.property('content');
    await Content.deleteMany({});
  });

  it('turns a full account away before reading the photo', async () => {
    const user = await User.findOne({ email: 'cloud-mode@tester.com' });
    await Content.insertMany(Array.from({ length: 5 }, () => ({ user_id: String(user._id), content: photo })));
    // Not even JSON: a 400 if it were read.
    const res = await request.execute(baseUri).post('/import').set({ token: token })
      .set('Content-Type', 'application/json').send('{"content": "data:image/jpeg;base64,');
    expect(res).to.have.status(409);
    await Content.deleteMany({});
  });

  it('can still filter on the server for signed-in users with device-first', () => {
    process.env.OMNIFILTER_PROCESSING = 'device-first';
    return request.execute(baseUri).post('/newcontent').set({ token: token })
      .send({ content: photo, tOption: 'invert' })
      .then((res) => expect(res).to.have.status(200))
      .finally(() => {
        delete process.env.OMNIFILTER_PROCESSING;
        return Content.deleteMany({});
      });
  });

  it('turns guests away when guests are off', () => {
    process.env.OMNIFILTER_GUESTS = 'off';
    return request.execute(baseUri).post('/transform').send({ content: photo, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(403);
        expect(res.body.msg).to.match(/Sign in/);
      })
      .finally(() => { delete process.env.OMNIFILTER_GUESTS; });
  });
});

describe('GET /health', () => {
  it('says the database is connected, and gives the caller\'s address', () => {
    return request.execute(baseUri).get('/health').then((res) => {
      expect(res).to.have.status(200);
      expect(res).to.have.header('cache-control', 'no-store');
      expect(res.body).to.include({ ok: true, database: true });
      expect(res.body.ip).to.match(/127\.0\.0\.1|::1/);
    });
  });
});
