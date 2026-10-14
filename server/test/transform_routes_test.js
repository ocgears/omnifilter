require(__dirname + '/../server.js');
const { clearCollections } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const imageCodec = require(__dirname + '/../lib/image_codec');
const ref = require(__dirname + '/reference');
const sharp = require('sharp');
const gpuFilters = require(__dirname + '/../lib/gpu_filters');
const transformQueue = require(__dirname + '/../lib/transform_queue');
const neural = require(__dirname + '/../lib/filters/neural');
const neuralModels = require(__dirname + '/../lib/filters/neural_models');
const fs = require('fs');
const path = require('path');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var chaiHTTP = require('chai-http');
chai.use(chaiHTTP);
var mongoose = require('mongoose');
var expect = chai.expect;

// A gradient with a hard edge in the middle, so blur and sharpen both change it.
function testImage(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = x < width / 2 ? 30 : 220;
      data[o + 1] = Math.floor(255 * y / height);
      data[o + 2] = 128;
      data[o + 3] = 255;
    }
  }
  return data;
}

function encode(format, data, width, height) {
  return sharp(Buffer.from(data), { raw: { width: width, height: height, channels: 4 } })
    .toFormat(format, { quality: 95 })
    .toBuffer()
    .then((bytes) => 'data:image/' + format + ';base64,' + bytes.toString('base64'));
}

describe('image codec', () => {
  it('round-trips a PNG exactly, including alpha', () => {
    // Fully transparent pixels may lose their colour, so keep alpha above 0.
    const pixels = Buffer.from(ref.randomImage(5, 3, 9).map((v, i) => (i % 4 === 3 ? Math.max(v, 1) : v)));
    return encode('png', pixels, 5, 3)
      .then((dataUrl) => imageCodec.decodeDataUrl(dataUrl))
      .then((image) => {
        expect([image.mime, image.width, image.height]).to.eql(['image/png', 5, 3]);
        expect(image.data).to.eql(pixels);
        return imageCodec.encodeDataUrl(image);
      })
      .then((dataUrl) => imageCodec.decodeDataUrl(dataUrl))
      .then((image) => expect(image.data).to.eql(pixels));
  });

  it('decodes other formats and saves them as PNG', () => {
    return encode('webp', testImage(8, 8), 8, 8)
      .then((dataUrl) => imageCodec.decodeDataUrl(dataUrl))
      .then((image) => {
        expect([image.mime, image.width, image.height]).to.eql(['image/png', 8, 8]);
        expect(image.data.length).to.eql(8 * 8 * 4);
      });
  });

  it('applies the EXIF orientation', () => {
    // A 4x2 image tagged "rotate 90 degrees" should come out 2x4.
    return sharp(testImage(4, 2), { raw: { width: 4, height: 2, channels: 4 } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer()
      .then((bytes) => imageCodec.decodeDataUrl('data:image/jpeg;base64,' + bytes.toString('base64')))
      .then((image) => expect([image.width, image.height]).to.eql([2, 4]));
  });

  it('refuses an SVG or PDF sent as a JPEG, without echoing libvips errors', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
    return Promise.all([svg, pdf].map((doc) =>
      imageCodec.decodeDataUrl('data:image/jpeg;base64,' + Buffer.from(doc).toString('base64')).then(
        () => { throw new Error('should have rejected'); },
        (err) => {
          expect(err.status).to.eql(400);
          expect(err.message).to.match(/^Unsupported or corrupt image/);
          expect(err.message).to.not.match(/vips|loader|buffer/i);
        })));
  });

  ['not a data url', 'data:text/plain;base64,aGk=', 'data:image/jpeg;base64,bm90IGFuIGltYWdl']
    .forEach((bad) => {
      it('rejects ' + bad.slice(0, 24), () => {
        return imageCodec.decodeDataUrl(bad).then(
          () => { throw new Error('should have rejected'); },
          (err) => expect(err.message).to.match(/image/));
      });
    });
});

// Noise compresses badly, so the PNG of it is much bigger than a JPEG.
function noiseImage(width, height, alpha) {
  const data = Buffer.from(ref.randomImage(width, height, 3));
  if (alpha === undefined) return data;
  for (var i = 3; i < data.length; i += 4) data[i] = alpha;
  return data;
}

describe('saving large results', () => {
  var limit;
  beforeEach(() => { limit = imageCodec.MAX_DATA_URL_LENGTH; });
  afterEach(() => { imageCodec.MAX_DATA_URL_LENGTH = limit; });

  it('keeps PNG when it fits', () => {
    return imageCodec.encodeDataUrl({ mime: 'image/png', width: 64, height: 64, data: noiseImage(64, 64, 255) })
      .then((url) => expect(url).to.match(/^data:image\/png;/));
  });

  it('falls back to JPEG for an opaque image whose PNG is too big', () => {
    const image = { mime: 'image/png', width: 64, height: 64, data: noiseImage(64, 64, 255) };
    return imageCodec.encodeDataUrl(image).then((png) => {
      imageCodec.MAX_DATA_URL_LENGTH = Math.floor(png.length / 2);
      return imageCodec.encodeDataUrl(image);
    }).then((url) => {
      expect(url).to.match(/^data:image\/jpeg;/);
      expect(url.length).to.be.at.most(imageCodec.MAX_DATA_URL_LENGTH);
    });
  });

  it('falls back to WebP, keeping transparency, for an image with alpha', () => {
    const image = { mime: 'image/png', width: 64, height: 64, data: noiseImage(64, 64, 128) };
    return imageCodec.encodeDataUrl(image).then((png) => {
      imageCodec.MAX_DATA_URL_LENGTH = Math.floor(png.length / 2);
      return imageCodec.encodeDataUrl(image);
    })
      .then((url) => {
        expect(url).to.match(/^data:image\/webp;/);
        return sharp(Buffer.from(url.split(',')[1], 'base64')).metadata();
      })
      .then((meta) => expect(meta.hasAlpha).to.equal(true));
  });

  it('rejects with a 413 when nothing fits', () => {
    imageCodec.MAX_DATA_URL_LENGTH = 100;
    return imageCodec.encodeDataUrl({ mime: 'image/png', width: 64, height: 64, data: noiseImage(64, 64, 255) })
      .then(() => { throw new Error('should have rejected'); },
        (err) => {
          expect(err.status).to.eql(413);
          expect(err.message).to.match(/too large to save/);
        });
  });
});

describe('the transform queue', () => {
  // A job that runs until finish() is called.
  function job() {
    var finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const fn = () => { fn.started = true; return done; };
    fn.finish = finish;
    return fn;
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('runs a few at once, queues a few more, and turns the rest away', () => {
    const q = transformQueue.create({ maxRunning: 1, maxWaiting: 2, maxPerKey: 1 });
    const jobs = [job(), job(), job(), job()];
    const runs = jobs.map((fn, i) => q.run('user' + i, fn).then(() => 'ok', (e) => e.status));
    return tick().then(() => {
      expect(jobs.map((j) => Boolean(j.started))).to.eql([true, false, false, false]);
      expect(q.stats()).to.include({ running: 1, waiting: 2 });
      jobs.forEach((j) => j.finish());
      return Promise.all(runs);
    }).then((results) => {
      expect(results).to.eql(['ok', 'ok', 'ok', 503]);
      expect(q.stats()).to.eql({ running: 0, waiting: 0, keys: 0 });
    });
  });

  it('lets each user have one transform at a time', () => {
    const q = transformQueue.create({ maxRunning: 2, maxWaiting: 8, maxPerKey: 1 });
    const first = job();
    const running = q.run('alice', first);
    return q.run('alice', job()).then(() => { throw new Error('should have been refused'); }, (e) => {
      expect(e.status).to.eql(429);
      expect(e.retryAfter).to.be.above(0);
      first.finish();
      return running;
    }).then(() => q.run('alice', () => 'again')).then((result) => expect(result).to.eql('again'));
  });

  it('drops a waiting transform whose client went away, without running it', () => {
    const q = transformQueue.create({ maxRunning: 1, maxWaiting: 2, maxPerKey: 1 });
    const first = job();
    const second = job();
    const third = job();
    const cancel = new AbortController();
    const runs = [
      q.run('a', first),
      q.run('b', second, cancel.signal).then(() => 'ran', (e) => (e.aborted ? 'aborted' : e)),
      q.run('c', third)
    ];
    cancel.abort();
    expect(q.stats()).to.include({ running: 1, waiting: 1 });
    first.finish();
    return tick().then(() => {
      expect(second.started).to.not.equal(true);
      expect(third.started).to.equal(true);
      // Aborting once it has started changes nothing, and the slot is
      // released only once.
      cancel.abort();
      third.finish();
      return Promise.all(runs);
    }).then((results) => {
      expect(results[1]).to.eql('aborted');
      expect(q.stats()).to.eql({ running: 0, waiting: 0, keys: 0 });
    });
  });

  it('frees the slot when a transform fails', () => {
    const q = transformQueue.create({ maxRunning: 1, maxWaiting: 1, maxPerKey: 1 });
    return q.run('a', () => { throw new Error('boom'); })
      .then(() => { throw new Error('should have failed'); }, (e) => expect(e.message).to.eql('boom'))
      .then(() => expect(q.stats()).to.eql({ running: 0, waiting: 0, keys: 0 }));
  });
});

describe('neural style sessions', () => {
  const file = neuralModels.STYLES[0].file;
  var realOrt;
  beforeEach(() => {
    realOrt = neural.ort;
    neural.sessions.delete(file);
  });
  afterEach(() => {
    neural.ort = realOrt;
    neural.sessions.delete(file);
  });

  it('does not cache a session that failed to load, so the next request retries', function() {
    if (!fs.existsSync(path.join(neuralModels.MODEL_DIR, file)) || !neural.session) return this.skip();
    var calls = 0;
    neural.ort = { InferenceSession: { create: () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('out of memory')) : Promise.resolve({ ok: true });
    } } };
    return neural.session(file).then(() => { throw new Error('should have failed'); },
      (err) => expect(err.message).to.eql('out of memory'))
      .then(() => neural.session(file))
      .then((s) => {
        expect(s).to.eql({ ok: true });
        expect(calls).to.eql(2);
        return neural.session(file);
      })
      .then(() => expect(calls, 'a working session is cached').to.eql(2));
  });

  it('retries a model file that was missing', () => {
    if (!neural.session) return;
    const missing = 'not-downloaded-yet.onnx';
    return neural.session(missing).then(() => { throw new Error('should have failed'); },
      (err) => {
        expect(err.code).to.eql('ENOENT');
        return new Promise((resolve) => setImmediate(resolve));
      })
      .then(() => expect(neural.sessions.has(missing)).to.equal(false));
  });
});

describe('GET /device', () => {
  it('names the device the filters run on', () => {
    return chai.request(baseUri).get('/device').then((res) => {
      expect(res).to.have.status(200);
      expect(res.body.name).to.be.a('string').that.is.not.empty;
      expect(['gpu', 'cpu', 'accelerator', 'other']).to.include(res.body.type);
    });
  });
});

describe('GET /filters', () => {
  it('lists the filters with their groups and parameters', (done) => {
    chai.request(baseUri)
      .get('/filters')
      .end((err, res) => {
        expect(err).to.eql(null);
        expect(res).to.have.status(200);
        const blur = res.body.find((f) => f.name === 'blur');
        expect(blur.group).to.equal('Blur & sharpen');
        expect(blur.params[0]).to.include({ name: 'radius', type: 'range' });
        expect(res.body.every((f) => !('plan' in f) && !('run' in f))).to.equal(true);
        done();
      });
  });
});

describe('POST /newcontent with a transformation', function() {
  this.timeout(20000);
  var userToken;
  const width = 120;
  const height = 80;
  const original = testImage(width, height);
  var jpegUrl;

  before(() => {
    var user = new User();
    user.email = 'gpu@tester.com';
    user.hashPassword('password');
    return Promise.all([
      user.save().then((data) => {
        userToken = data.generateToken();
      }),
      encode('jpeg', original, width, height).then((dataUrl) => {
        jpegUrl = dataUrl;
      })
    ]);
  });

  after(() => clearCollections());

  ['blur', 'sharpen', 'cartoon', 'stained_glass'].forEach((tOption) => {
    it('applies ' + tOption + ' and returns a JPEG', (done) => {
      chai.request(baseUri)
        .post('/newcontent')
        .set({ token: userToken })
        .send({ content: jpegUrl, tOption: tOption })
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body.tOption).to.eql(tOption);
          expect(res.body.content).to.match(/^data:image\/jpeg;base64,/);
          imageCodec.decodeDataUrl(res.body.content).then((result) => {
            expect([result.width, result.height]).to.eql([width, height]);
            // The filter must actually have changed the picture.
            expect(ref.compare(result.data, original).max).to.be.above(20);
            done();
          }).catch(done);
        });
    });
  });

  it('uses and stores the parameters, clamped to their ranges', (done) => {
    chai.request(baseUri)
      .post('/newcontent')
      .set({ token: userToken })
      .send({ content: jpegUrl, tOption: 'pixelate', params: { block: 500, extra: 'ignored' } })
      .end((err, res) => {
        expect(res).to.have.status(200);
        expect(res.body.tParams).to.eql({ block: 10 });
        done();
      });
  });

  it('rejects an unknown transformation', (done) => {
    chai.request(baseUri)
      .post('/newcontent')
      .set({ token: userToken })
      .send({ content: jpegUrl, tOption: 'explode' })
      .end((err, res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.match(/Unknown transformation/);
        done();
      });
  });

  it('rejects a filter the device cannot run with a 400 and the reason', () => {
    const list = gpuFilters.list;
    gpuFilters.list = () => list().map((f) => (f.name !== 'blur' ? f :
      Object.assign({}, f, { available: false, unavailableReason: 'needs image (texture) support' })));
    return chai.request(baseUri).post('/newcontent').set({ token: userToken })
      .send({ content: jpegUrl, tOption: 'blur' })
      .then((res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.match(/can't run on this server: needs image/);
      })
      .finally(() => { gpuFilters.list = list; });
  });

  [
    [{ code: 'UNSUPPORTED', status: 400, message: 'A 120x80 image is too large for this filter on X' }, 400, /too large/],
    [{ code: 'NO_DEVICE', message: 'No OpenCL devices found' }, 503, /No OpenCL device/],
    [{ message: 'driver exploded' }, 500, /^transform failure$/]
  ].forEach((c) => {
    it('answers a ' + (c[0].code || 'filter') + ' error with a ' + c[1], () => {
      const apply = gpuFilters.apply;
      gpuFilters.apply = () => Promise.reject(Object.assign(new Error(c[0].message), c[0]));
      return chai.request(baseUri).post('/newcontent').set({ token: userToken })
        .send({ content: jpegUrl, tOption: 'blur' })
        .then((res) => {
          expect(res).to.have.status(c[1]);
          expect(res.body.msg).to.match(c[2]);
        })
        .finally(() => { gpuFilters.apply = apply; });
    });
  });

  it('answers a result too large to store with a 413', () => {
    const limit = imageCodec.MAX_DATA_URL_LENGTH;
    imageCodec.MAX_DATA_URL_LENGTH = 100;
    return chai.request(baseUri).post('/newcontent').set({ token: userToken })
      .send({ content: jpegUrl, tOption: 'invert' })
      .then((res) => {
        expect(res).to.have.status(413);
        expect(res.body.msg).to.match(/too large to save/);
      })
      .finally(() => { imageCodec.MAX_DATA_URL_LENGTH = limit; });
  });

  it('saves a WebP whose PNG would be too large as a smaller format', () => {
    const limit = imageCodec.MAX_DATA_URL_LENGTH;
    var webpUrl;
    return encode('webp', noiseImage(width, height, 255), width, height)
      .then((url) => {
        webpUrl = url;
        return imageCodec.decodeDataUrl(url);
      })
      .then((image) => imageCodec.encodeDataUrl(image))
      .then((png) => {
        imageCodec.MAX_DATA_URL_LENGTH = Math.floor(png.length / 2);
        return chai.request(baseUri).post('/newcontent').set({ token: userToken })
          .send({ content: webpUrl, tOption: 'invert' });
      })
      .then((res) => {
        expect(res).to.have.status(200);
        expect(res.body.content).to.match(/^data:image\/jpeg;/);
      })
      .finally(() => { imageCodec.MAX_DATA_URL_LENGTH = limit; });
  });

  it('turns away a second transform from the same user while one is running', () => {
    const apply = gpuFilters.apply;
    var release;
    const gate = new Promise((resolve) => { release = resolve; });
    gpuFilters.apply = (name, rgba) => gate.then(() => Buffer.from(rgba));
    const first = chai.request(baseUri).post('/newcontent').set({ token: userToken })
      .send({ content: jpegUrl, tOption: 'invert' }).then((res) => res);
    return new Promise((resolve) => setTimeout(resolve, 200))
      .then(() => chai.request(baseUri).post('/newcontent').set({ token: userToken })
        .send({ content: jpegUrl, tOption: 'invert' }))
      .then((res) => {
        expect(res).to.have.status(429);
        expect(res.headers['retry-after']).to.match(/^\d+$/);
        release();
        return first;
      })
      .then((res) => expect(res).to.have.status(200))
      .finally(() => { gpuFilters.apply = apply; release(); });
  });

  it('rejects an image type it cannot decode', (done) => {
    chai.request(baseUri)
      .post('/newcontent')
      .set({ token: userToken })
      .send({ content: 'data:image/gif;base64,bm90IGFuIGltYWdl', tOption: 'blur' })
      .end((err, res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.match(/Could not read the image/);
        done();
      });
  });
});
