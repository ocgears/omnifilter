require(__dirname + '/../server.js');
const { clearCollections } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const contentRouter = require(__dirname + '/../routes/content_routes');
const settings = require(__dirname + '/../lib/settings');
const sharp = require('sharp');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var chaiHTTP = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;

const KEYS = ['OMNIFILTER_MODE', 'OMNIFILTER_PROCESSING', 'OMNIFILTER_GUESTS', 'OMNIFILTER_MAX_STORED_PHOTOS'];

describe('the server settings (lib/settings.js)', () => {
  it('filters on the server for everyone by default, and keeps any number of photos', () => {
    expect(settings.read({})).to.eql({
      mode: 'standard', processing: 'server', guests: 'server', maxStoredPhotos: null
    });
  });

  it('in cloud mode, filters on the visitor\'s device and keeps 5 photos each', () => {
    expect(settings.read({ OMNIFILTER_MODE: 'cloud' })).to.eql({
      mode: 'cloud', processing: 'device', guests: 'device', maxStoredPhotos: 5
    });
  });

  it('lets each cloud setting be changed on its own', () => {
    expect(settings.read({
      OMNIFILTER_MODE: 'Cloud', OMNIFILTER_PROCESSING: 'device-first', OMNIFILTER_GUESTS: 'off',
      OMNIFILTER_MAX_STORED_PHOTOS: '12'
    })).to.eql({ mode: 'cloud', processing: 'device-first', guests: 'off', maxStoredPhotos: 12 });
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
    return chai.request(baseUri).get('/settings').then((res) => {
      expect(res).to.have.status(200);
      expect(res.body).to.include({ mode: 'cloud', processing: 'device', guests: 'device', maxStoredPhotos: 5 });
      expect(res.body.maxPixels).to.be.above(0);
    });
  });

  it('runs no filters for guests', () => {
    return chai.request(baseUri).post('/transform').send({ content: photo, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(403);
        expect(res.body.msg).to.match(/run on your own device/);
      });
  });

  it('runs no filters for signed-in users, but keeps photos as they are', () => {
    return chai.request(baseUri).post('/newcontent').set({ token: token })
      .send({ content: photo, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(403);
        return chai.request(baseUri).post('/newcontent').set({ token: token }).send({ content: photo });
      })
      .then((res) => expect(res).to.have.status(200))
      .then(() => Content.deleteMany({}));
  });

  it('keeps 5 photos for each account, then refuses more until one is deleted', async () => {
    const keep = () => chai.request(baseUri).post('/import').set({ token: token })
      .send({ content: photo, tOption: 'invert' });
    for (let n = 0; n < 5; n++) expect(await keep()).to.have.status(200);
    const refused = await keep();
    expect(refused).to.have.status(409);
    expect(refused.body).to.include({ limit: 5 });
    expect(refused.body.msg).to.match(/already keep 5 photos/);
    // Saving the photo as it is counts too.
    expect(await chai.request(baseUri).post('/newcontent').set({ token: token }).send({ content: photo }))
      .to.have.status(409);

    const one = await Content.findOne({});
    expect(await chai.request(baseUri).delete('/delete/' + one._id).set({ token: token })).to.have.status(200);
    expect(await keep()).to.have.status(200);
    await Content.deleteMany({});
  });

  it('can still filter on the server for signed-in users with device-first', () => {
    process.env.OMNIFILTER_PROCESSING = 'device-first';
    return chai.request(baseUri).post('/newcontent').set({ token: token })
      .send({ content: photo, tOption: 'invert' })
      .then((res) => expect(res).to.have.status(200))
      .finally(() => {
        delete process.env.OMNIFILTER_PROCESSING;
        return Content.deleteMany({});
      });
  });

  it('turns guests away when guests are off', () => {
    process.env.OMNIFILTER_GUESTS = 'off';
    return chai.request(baseUri).post('/transform').send({ content: photo, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(403);
        expect(res.body.msg).to.match(/Sign in/);
      })
      .finally(() => { delete process.env.OMNIFILTER_GUESTS; });
  });
});
