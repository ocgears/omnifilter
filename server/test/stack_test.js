// Filter stacks: the GPU blend kernel against the W3C formulas, stack
// validation, the presets, and the API.
require(__dirname + '/../server.js');
const { clearCollections } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const gpu = require(__dirname + '/../lib/gpu_filters');
const stack = require(__dirname + '/../lib/stack');
const ref = require(__dirname + '/reference');
const sharp = require('sharp');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var chaiHTTP = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;

const W = 48;
const H = 32;
const base = ref.randomImage(W, H, 11);
const top = ref.randomImage(W, H, 23);

describe('blend kernel', () => {
  for (const mode of stack.BLEND_MODES) {
    it('matches the W3C formula for ' + mode, () => {
      return Promise.all([1, 0.4].map((amount) => stack.blend(top, base, W, H, mode, amount * 100)
        .then((out) => {
          const diff = ref.compare(out, ref.blend(top, base, mode, amount));
          expect(diff.max, mode + ' at ' + amount).to.be.at.most(1);
        })));
    });
  }

  it('lays a layer over a transparent base keeping its colour', () => {
    const red = new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]);
    const clear = new Uint8Array(8);
    return Promise.all(['normal', 'multiply', 'screen', 'difference', 'luminosity'].map((mode) =>
      stack.blend(red, clear, 2, 1, mode, 50).then((out) => {
        expect(Array.from(out.slice(0, 4)), mode).to.eql([255, 0, 0, 128]);
      })));
  });

  it('keeps a semi-transparent image\'s alpha when a filter keeps it', () => {
    const half = ref.randomImage(W, H, 31).map((v, i) => (i % 4 === 3 ? 128 : v));
    return gpu.apply('grayscale', half, W, H, {})
      .then((grey) => stack.blend(grey, half, W, H, 'multiply', 50))
      .then((out) => expect(Array.from(out).filter((v, i) => i % 4 === 3).every((a) => a === 128)).to.equal(true));
  });

  it('leaves the base unchanged at strength 0', () => {
    // Fully transparent pixels come out as transparent black.
    return stack.blend(top, base, W, H, 'multiply', 0)
      .then((out) => expect(ref.compare(out, ref.visible(base)).max).to.equal(0));
  });
});

describe('filter stacks', () => {
  it('runs a one-layer stack exactly like the filter on its own', () => {
    const layers = stack.normalizeStack([{ tOption: 'sepia' }]);
    return Promise.all([
      stack.applyStack(layers, base, W, H),
      gpu.apply('sepia', base, W, H, {})
    ]).then((results) => expect(ref.compare(results[0], results[1]).max).to.equal(0));
  });

  it('feeds each layer the result of the one before', () => {
    const layers = stack.normalizeStack([
      { tOption: 'invert' },
      { tOption: 'posterize', params: { levels: 3 } }
    ]);
    return gpu.apply('invert', base, W, H, {})
      .then((inverted) => Promise.all([
        stack.applyStack(layers, base, W, H),
        gpu.apply('posterize', inverted, W, H, { levels: 3 })
      ]))
      .then((results) => expect(ref.compare(results[0], results[1]).max).to.equal(0));
  });

  it('blends each layer over its own input', () => {
    const layers = stack.normalizeStack([
      { tOption: 'invert' },
      { tOption: 'grayscale', blend: 'multiply', amount: 50 }
    ]);
    return gpu.apply('invert', base, W, H, {})
      .then((inverted) => gpu.apply('grayscale', inverted, W, H, {})
        .then((grey) => Promise.all([stack.applyStack(layers, base, W, H), ref.blend(grey, inverted, 'multiply', 0.5)])))
      .then((results) => expect(ref.compare(results[0], results[1]).max).to.be.at.most(1));
  });

  it('fills in and clamps layer settings', () => {
    const layers = stack.normalizeStack([{ tOption: 'blur', params: { radius: 99 }, amount: 250, blend: 'nope' }]);
    expect(layers).to.eql([{ tOption: 'blur', tParams: { radius: 5 }, amount: 100, blend: 'normal' }]);
  });

  for (const bad of [
    ['a missing list', undefined],
    ['an empty list', []],
    ['too many layers', new Array(stack.MAX_LAYERS + 1).fill({ tOption: 'invert' })],
    ['an unknown filter', [{ tOption: 'nope' }]],
    ['a filter name that is an object', [{ tOption: { toString: 1 } }]],
    ['a layer that is not an object', ['invert']]
  ]) {
    it('rejects ' + bad[0], () => {
      expect(() => stack.normalizeStack(bad[1])).to.throw();
    });
  }
});

describe('presets', () => {
  const filterNames = new Set(gpu.list().map((f) => f.name));

  it('have unique names and only use known filters', () => {
    const presets = stack.presets();
    expect(presets.length).to.be.at.least(4);
    expect(new Set(presets.map((p) => p.name)).size).to.equal(presets.length);
    for (const p of presets) {
      expect(p.label, p.name).to.be.a('string').that.is.not.empty;
      expect(p.description, p.name).to.be.a('string').that.is.not.empty;
      for (const layer of p.stack) expect(filterNames.has(layer.tOption), p.name + ': ' + layer.tOption).to.equal(true);
    }
  });

  for (const preset of stack.presets()) {
    it('runs ' + preset.name, function() {
      this.timeout(30000);
      return stack.applyStack(stack.normalizeStack(preset.stack), base, W, H).then((out) => {
        expect(out.length).to.equal(W * H * 4);
        expect(ref.compare(out, base).count, 'changes the image').to.be.above(0);
      });
    });
  }
});

describe('stacks through the API', () => {
  var token;
  var content;

  before(() => {
    const user = new User();
    user.email = 'stacker@tester.com';
    user.hashPassword('password1');
    return user.save()
      .then((saved) => {
        token = saved.generateToken();
        return sharp(Buffer.from(base), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
      })
      .then((png) => { content = 'data:image/png;base64,' + png.toString('base64'); });
  });

  after(() => clearCollections());

  it('lists the presets and layer controls', () => {
    return chai.request(baseUri).get('/presets').then((res) => {
      expect(res).to.have.status(200);
      expect(res.body.maxLayers).to.equal(stack.MAX_LAYERS);
      expect(res.body.layerParams.map((p) => p.name)).to.eql(['amount', 'blend']);
      expect(res.body.presets.length).to.equal(stack.presets().length);
    });
  });

  it('applies a stack and stores its layers', () => {
    return chai.request(baseUri).post('/newcontent').set({ token: token })
      .send({ content: content, stack: [
        { tOption: 'sepia' },
        { tOption: 'vignette', params: { strength: 80 }, blend: 'multiply', amount: 60 }
      ] })
      .then((res) => {
        expect(res).to.have.status(200);
        expect(res.body.tOption).to.equal('');
        expect(res.body.tStack.map((l) => [l.tOption, l.amount, l.blend]))
          .to.eql([['sepia', 100, 'normal'], ['vignette', 60, 'multiply']]);
        expect(res.body.tStack[1].tParams.strength).to.equal(80);
        expect(res.body.content).to.not.equal(content);
      });
  });

  it('rejects a bad stack with a 400', () => {
    return chai.request(baseUri).post('/newcontent').set({ token: token })
      .send({ content: content, stack: [{ tOption: 'nope' }] })
      .then((res) => {
        expect(res).to.have.status(400);
        expect(res.body.msg).to.include('not a known filter');
      });
  });
});
