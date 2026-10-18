require(__dirname + '/../server.js');
const { clearCollections, keptPhoto } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const contentRouter = require(__dirname + '/../routes/content_routes');
const authRouter = require(__dirname + '/../routes/auth_routes');
const settings = require(__dirname + '/../lib/settings');
const storageGuard = require(__dirname + '/../lib/storage_guard');
const sharp = require('sharp');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var { default: chaiHTTP, request } = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;

// A PNG with n bytes of noise in a chunk of its own (one image readers skip),
// before its end.
function paddedPng(png, n) {
  const type = Buffer.from('paDd');
  const data = crypto.randomBytes(n);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
  const end = png.length - 12;
  return Buffer.concat([png.subarray(0, end), length, type, data, crc, png.subarray(end)]);
}

// Sends a photo to keep and goes away once it's sent, without the answer.
function sendAndLeave(token, bytes) {
  return new Promise((resolve) => {
    const req = http.request('http://' + baseUri + '/import', {
      method: 'POST',
      headers: { token: token, 'Content-Type': 'image/png', 'Content-Length': bytes.length }
    });
    req.on('error', () => {});
    req.end(bytes, () => setTimeout(() => {
      req.destroy();
      resolve();
    }, 100));
  });
}

const KEYS = ['OMNIFILTER_MODE', 'OMNIFILTER_PROCESSING', 'OMNIFILTER_GUESTS', 'OMNIFILTER_MAX_STORED_PHOTOS',
  'OMNIFILTER_KEEP_MAX_SIDE', 'OMNIFILTER_KEEP_MAX_PIXELS', 'OMNIFILTER_KEEP_MAX_BYTES', 'OMNIFILTER_SIGNUPS_PER_DAY',
  'OMNIFILTER_MAX_DATA_MB', 'OMNIFILTER_LIMITS'];

describe('the server settings (lib/settings.js)', () => {
  it('filters on the server for everyone by default, and keeps any number of photos', () => {
    expect(settings.read({})).to.eql({
      mode: 'standard', strict: false, processing: 'server', guests: 'server', maxStoredPhotos: null,
      keepMaxSide: null, keepMaxPixels: null, keepMaxBytes: null, signupsPerDay: null, maxDataMB: null
    });
  });

  it('has strict limits on photos and accounts when asked', () => {
    expect(settings.read({ OMNIFILTER_LIMITS: 'strict' })).to.include({
      strict: true, keepMaxPixels: 16e6, keepMaxBytes: 3e6, signupsPerDay: 10, maxDataMB: null
    });
    expect(settings.read({ OMNIFILTER_MODE: 'cloud', OMNIFILTER_LIMITS: 'Strict', OMNIFILTER_SIGNUPS_PER_DAY: '4' }))
      .to.include({ keepMaxPixels: 16e6, signupsPerDay: 4, maxDataMB: 400 });
  });

  it('in cloud mode, filters on the visitor\'s device and keeps 5 photos each', () => {
    expect(settings.read({ OMNIFILTER_MODE: 'cloud' })).to.eql({
      mode: 'cloud', strict: false, processing: 'device', guests: 'device', maxStoredPhotos: 5, keepMaxSide: 2048,
      keepMaxPixels: null, keepMaxBytes: null, signupsPerDay: null, maxDataMB: 400
    });
  });

  it('lets each cloud setting be changed on its own', () => {
    expect(settings.read({
      OMNIFILTER_MODE: 'Cloud', OMNIFILTER_PROCESSING: 'device-first', OMNIFILTER_GUESTS: 'off',
      OMNIFILTER_MAX_STORED_PHOTOS: '12', OMNIFILTER_KEEP_MAX_SIDE: '4096', OMNIFILTER_KEEP_MAX_PIXELS: '30e6',
      OMNIFILTER_KEEP_MAX_BYTES: '5e6', OMNIFILTER_SIGNUPS_PER_DAY: '3', OMNIFILTER_MAX_DATA_MB: '900'
    })).to.eql({
      mode: 'cloud', strict: false, processing: 'device-first', guests: 'off', maxStoredPhotos: 12, keepMaxSide: 4096,
      keepMaxPixels: 30e6, keepMaxBytes: 5e6, signupsPerDay: 3, maxDataMB: 900
    });
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

  it('runs no filters for signed-in users, but keeps photos filtered on their device', () => {
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

  it('keeps a photo\'s pixels, and not what else its file carries', async () => {
    const small = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#406080' } })
      .png().toBuffer();
    const located = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#406080' } })
      .jpeg().withExif({ IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '47/1 36/1 0/1' } })
      .toBuffer();
    expect((await sharp(located).metadata()).exif).to.not.eql(undefined);
    for (const [bytes, type] of [[paddedPng(small, 2e6), 'image/png'], [located, 'image/jpeg']]) {
      const res = await request.execute(baseUri).post('/import').set({ token: token })
        .set('Content-Type', type).send(bytes);
      expect(res).to.have.status(200);
      const kept = Buffer.from((await keptPhoto(baseUri, token, res.body._id)).split(',')[1], 'base64');
      expect(kept.length).to.be.below(50000);
      const meta = await sharp(kept).metadata();
      expect([meta.format, meta.exif]).to.eql(['jpeg', undefined]);
    }
    await Content.deleteMany({});
  });

  it('turns away a photo with more pixels than it takes in to keep, with strict limits', async () => {
    process.env.OMNIFILTER_LIMITS = 'strict';
    const big = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#406080' } })
      .jpeg().toBuffer();
    const res = await request.execute(baseUri).post('/import').set({ token: token })
      .set('Content-Type', 'image/jpeg').send(big);
    expect(res).to.have.status(400);
    expect(res.body.msg).to.match(/at most 16 megapixels/);
    expect(await Content.countDocuments({})).to.eql(0);
    // Without them, it's kept (at 2048 pixels).
    delete process.env.OMNIFILTER_LIMITS;
    const kept = await request.execute(baseUri).post('/import').set({ token: token })
      .set('Content-Type', 'image/jpeg').send(big);
    expect(kept).to.have.status(200);
    expect(kept.body).to.include({ width: 2048, height: 1638 });
    await Content.deleteMany({});
  });

  it('keeps to the limit when clients send photos and go without waiting', async () => {
    const bytes = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#406080' } })
      .png({ progressive: true }).toBuffer();
    // One after another, each as soon as the last has gone.
    for (let n = 0; n < 12; n++) await sendAndLeave(token, bytes);
    // Until the server has finished with them all: no more for a second.
    var kept = -1;
    for (let same = 0; same < 5;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const now = await Content.countDocuments({});
      same = now === kept ? same + 1 : 0;
      kept = now;
    }
    expect(kept).to.be.above(0);
    expect(kept).to.be.at.most(5);
    await Content.deleteMany({});
  });

  it('keeps a photo with a lot of detail at a lower quality, or not at all', async () => {
    const noise = await sharp(crypto.randomBytes(800 * 800 * 3), { raw: { width: 800, height: 800, channels: 3 } })
      .png().toBuffer();
    const keep = () => request.execute(baseUri).post('/import').set({ token: token })
      .set('Content-Type', 'image/png').send(noise);
    // About 530 kB at quality 90, and 370 kB at 70.
    process.env.OMNIFILTER_KEEP_MAX_BYTES = '450000';
    const lower = await keep();
    expect(lower).to.have.status(200);
    const kept = Buffer.from((await keptPhoto(baseUri, token, lower.body._id)).split(',')[1], 'base64');
    expect(kept.length).to.be.at.most(450000);
    process.env.OMNIFILTER_KEEP_MAX_BYTES = '200000';
    const refused = await keep();
    expect(refused).to.have.status(413);
    expect(refused.body.msg).to.match(/too much detail/);
    delete process.env.OMNIFILTER_KEEP_MAX_BYTES;
    await Content.deleteMany({});
  });

  it('makes only so many accounts a day from one address', async () => {
    process.env.OMNIFILTER_SIGNUPS_PER_DAY = '2';
    authRouter.resetSignupsPerDay();
    authRouter.rateLimiter.reset();
    const signUp = (email) => request.execute(baseUri).post('/signup')
      .send({ email: email, password: 'password5', confirmation: 'password5' });
    expect(await signUp('daily-1@tester.com')).to.have.status(200);
    // One that makes no account doesn't count.
    expect(await signUp('daily-1@tester.com')).to.have.status(409);
    expect(await signUp('daily-2@tester.com')).to.have.status(200);
    const third = await signUp('daily-3@tester.com');
    expect(third).to.have.status(429);
    expect(third.body.msg).to.match(/today/);
    expect(Number(third.headers['retry-after'])).to.be.above(3600);
    delete process.env.OMNIFILTER_SIGNUPS_PER_DAY;
    authRouter.resetSignupsPerDay();
    authRouter.rateLimiter.reset();
    await User.deleteMany({ email: /^daily-/ });
  });

  it('keeps no photos once the database is as big as it may be', async () => {
    const keep = () => request.execute(baseUri).post('/import').set({ token: token })
      .send({ content: photo, tOption: 'invert' });
    process.env.OMNIFILTER_MAX_DATA_MB = '0.001';
    storageGuard.reset();
    const refused = await keep();
    expect(refused).to.have.status(507);
    expect(refused.body.msg).to.match(/no room/);
    delete process.env.OMNIFILTER_MAX_DATA_MB;
    expect(await keep()).to.have.status(200);
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
