require(__dirname + '/../server.js');
const { clearCollections, keptPhoto } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const contentRouter = require(__dirname + '/../routes/content_routes');
const gpuFilters = require(__dirname + '/../lib/gpu_filters');
const sharp = require('sharp');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var { default: chaiHTTP, request } = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;

const jpegUrl = (width, height) =>
  sharp({ create: { width: width, height: height, channels: 3, background: '#204080' } })
    .jpeg().toBuffer().then((bytes) => 'data:image/jpeg;base64,' + bytes.toString('base64'));

describe('guest mode', () => {
  var userToken;
  var photo;

  before(() => {
    const user = new User();
    user.email = 'guest-import@tester.com';
    user.hashPassword('password3');
    return Promise.all([user.save(), jpegUrl(8, 6)]).then(([saved, url]) => {
      userToken = saved.generateToken();
      photo = url;
    });
  });

  beforeEach(() => contentRouter.guestLimiter.reset());

  after(() => {
    contentRouter.guestLimiter.reset();
    return clearCollections();
  });

  it('says guests may use the filters, and how big a photo can be', () => {
    return request.execute(baseUri).get('/settings').then((res) => {
      expect(res).to.have.status(200);
      expect(res.body.guests).to.eql('server');
      expect(res.body.guestMaxPixels).to.eql(16e6);
    });
  });

  it('filters a photo without an account, and saves nothing', () => {
    return Content.countDocuments().then((before) => request.execute(baseUri)
      .post('/transform')
      .send({ content: photo, stack: [{ tOption: 'invert' }, { tOption: 'blur', amount: 50 }] })
      .then((res) => {
        expect(res).to.have.status(200);
        expect(res.body.content).to.match(/^data:image\/jpeg;base64,/);
        expect(res.body).to.not.have.property('_id');
        expect(res.body.tStack.map((l) => [l.tOption, l.amount])).to.eql([['invert', 100], ['blur', 50]]);
        expect(res.body.createdAt).to.be.a('string');
        return Content.countDocuments();
      })
      .then((after) => expect(after).to.eql(before)));
  });

  it('needs a filter to apply', () => {
    return request.execute(baseUri).post('/transform').send({ content: photo })
      .then((res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.match(/Choose a filter/);
      });
  });

  it('takes smaller photos from guests', () => {
    // 4000 x 4001 is just over 16 megapixels; one colour, so it's a small file.
    return jpegUrl(4000, 4001)
      .then((big) => request.execute(baseUri).post('/transform').send({ content: big, tOption: 'invert' }))
      .then((res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.match(/at most 16 megapixels/);
      });
  });

  it('limits how often one address can ask', () => {
    const ask = () => request.execute(baseUri).post('/transform').send({ tOption: 'invert' });
    return ask().then(ask).then(ask).then(ask).then((res) => {
      expect(res).to.have.status(429);
      expect(res.headers['retry-after']).to.match(/^\d+$/);
    });
  });

  it('runs one guest transform at a time for each address', () => {
    const apply = gpuFilters.apply;
    var release;
    const gate = new Promise((resolve) => { release = resolve; });
    gpuFilters.apply = (name, rgba) => gate.then(() => Buffer.from(rgba));
    const first = request.execute(baseUri).post('/transform')
      .send({ content: photo, tOption: 'invert' }).then((res) => res);
    return new Promise((resolve) => setTimeout(resolve, 200))
      .then(() => request.execute(baseUri).post('/transform').send({ content: photo, tOption: 'invert' }))
      .then((res) => {
        expect(res).to.have.status(429);
        release();
        return first;
      })
      .then((res) => expect(res).to.have.status(200))
      .finally(() => { gpuFilters.apply = apply; release(); });
  });

  describe('POST /import', () => {
    it('needs an account', () => {
      return request.execute(baseUri).post('/import').send({ content: photo })
        .then((res) => expect(res).to.have.status(401));
    });

    it('saves a photo made as a guest, with what it was made with and when', () => {
      const made = '2026-10-01T12:00:00.000Z';
      return request.execute(baseUri).post('/import').set({ token: userToken })
        .send({ content: photo, stack: [{ tOption: 'invert' }, { tOption: 'sepia' }], createdAt: made })
        .then(async (res) => {
          expect(res).to.have.status(200);
          expect(await keptPhoto(baseUri, userToken, res.body._id)).to.eql(photo);
          expect(res.body.tStack.map((l) => l.tOption)).to.eql(['invert', 'sepia']);
          expect(res.body.createdAt).to.eql(made);
          return request.execute(baseUri).get('/getAll').set({ token: userToken });
        })
        .then((res) => expect(res.body.map((p) => p.createdAt)).to.include(made));
    });

    it('refuses made-up filters, and a date in the future', () => {
      const future = new Date(Date.now() + 864e5).toISOString();
      return request.execute(baseUri).post('/import').set({ token: userToken })
        .send({ content: photo, tOption: 'no_such_filter' })
        .then((res) => {
          expect(res).to.have.status(400);
          return request.execute(baseUri).post('/import').set({ token: userToken })
            .send({ content: photo, tOption: 'invert', createdAt: future });
        })
        .then((res) => {
          expect(res).to.have.status(200);
          expect(new Date(res.body.createdAt).getTime()).to.be.below(Date.now() + 1000);
        });
    });

    it('refuses something that only claims to be an image', () => {
      return request.execute(baseUri).post('/import').set({ token: userToken })
        .send({ content: 'data:image/png;base64,bm90IGFuIGltYWdl', tOption: 'invert' })
        .then((res) => expect(res).to.have.status(400));
    });
  });
});
