require(__dirname + '/../server.js');
const { clearCollections } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const secret = require(__dirname + '/../lib/secret');
const imageCodec = require(__dirname + '/../lib/image_codec');
const authRouter = require(__dirname + '/../routes/auth_routes');
const userRouter = require(__dirname + '/../routes/user_routes');
const rateLimit = require(__dirname + '/../lib/rate_limit');
const migrateEmails = require(__dirname + '/../../scripts/migrate-emails');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var { default: chaiHTTP, request } = require('chai-http');
chai.use(chaiHTTP);
var expect = chai.expect;

// Cost-12 hashes take a moment each, and most tests here make the same two
// users, so each password is hashed once and the hash reused.
const hashes = new Map();
function makeUser(email, password) {
  const user = new User();
  user.email = email;
  if (!hashes.has(password)) hashes.set(password, user.hashPassword(password));
  return hashes.get(password).then((hash) => {
    user.password = hash;
    return user.save();
  });
}

const pngDataUrl = (width, height) =>
  sharp({ create: { width: width, height: height, channels: 3, background: '#000' } })
    .png().toBuffer().then((bytes) => 'data:image/png;base64,' + bytes.toString('base64'));

describe('security', () => {
  var alice;
  var aliceToken;
  var bob;
  var bobToken;

  beforeEach(() => {
    authRouter.rateLimiter.reset();
    authRouter.wrongPasswordLimiter.reset();
    userRouter.passwordTries.reset();
    userRouter.addressTries.reset();
  });

  beforeEach(() => clearCollections()
    .then(() => User.syncIndexes())
    .then(() => Promise.all([makeUser('alice@tester.com', 'password1'), makeUser('bob@tester.com', 'password2')]))
    .then((users) => {
      alice = users[0];
      bob = users[1];
      aliceToken = alice.generateToken();
      bobToken = bob.generateToken();
    }));

  after(() => clearCollections());

  describe('crafted requests', () => {
    it('rejects a non-string tOption instead of crashing', () => {
      return request.execute(baseUri).post('/newcontent').set({ token: aliceToken })
        .send({ content: 'data:image/png;base64,AAAA', tOption: { toString: 1 } })
        .then((res) => {
          expect(res).to.have.status(400);
          return request.execute(baseUri).get('/filters');
        })
        .then((res) => expect(res).to.have.status(200));
    });

    it('ignores parameter values that are objects', () => {
      return pngDataUrl(4, 4).then((content) => request.execute(baseUri).post('/newcontent')
        .set({ token: aliceToken })
        .send({ content: content, tOption: 'blur', params: { radius: { toString: 1 } } }))
        .then((res) => {
          expect(res).to.have.status(200);
          expect(res.body.tParams.radius).to.be.a('number');
        });
    });

    it('refuses to save something that is not an image', () => {
      return request.execute(baseUri).post('/newcontent').set({ token: aliceToken })
        // eslint-disable-next-line no-script-url
        .send({ content: 'javascript:alert(1)' })
        .then((res) => expect(res).to.have.status(400));
    });

    it('answers a malformed JSON body with JSON, not a stack trace', () => {
      return request.execute(baseUri).post('/signup').set('content-type', 'application/json')
        .send('{"email":')
        .then((res) => {
          expect(res).to.have.status(400);
          expect(res.body).to.have.property('msg');
          expect(res.text).to.not.include('at ');
        });
    });
  });

  describe('login tokens', () => {
    it('rejects a token carrying a query operator as the user id', () => {
      const forged = jwt.sign({ id: { $ne: null } }, secret);
      return request.execute(baseUri).get('/getAll').set({ token: forged })
        .then((res) => expect(res).to.have.status(401));
    });

    it('rejects a token signed with the old default secret', () => {
      const forged = jwt.sign({ id: String(alice._id) }, 'changethis');
      return request.execute(baseUri).get('/getAll').set({ token: forged })
        .then((res) => expect(res).to.have.status(401));
    });

    it('rejects an unsigned token', () => {
      const unsigned = jwt.sign({ id: String(alice._id) }, null, { algorithm: 'none' });
      return request.execute(baseUri).get('/getAll').set({ token: unsigned })
        .then((res) => expect(res).to.have.status(401));
    });

    it('rejects an expired token', () => {
      const expired = jwt.sign({ id: String(alice._id), exp: Math.floor(Date.now() / 1000) - 10 }, secret);
      return request.execute(baseUri).get('/getAll').set({ token: expired })
        .then((res) => expect(res).to.have.status(401));
    });

    it('gives tokens an expiry', () => {
      const decoded = jwt.decode(aliceToken);
      expect(decoded.exp - decoded.iat).to.eql(7 * 24 * 60 * 60);
    });
  });

  describe('photos belong to their owner', () => {
    var photo;
    beforeEach(() => Content.create({ user_id: alice._id, content: 'data:image/png;base64,AAAA' })
      .then((data) => { photo = data; }));

    it('does not let another user delete a photo', () => {
      return request.execute(baseUri).delete('/delete/' + photo._id).set({ token: bobToken })
        .then((res) => {
          expect(res).to.have.status(404);
          return Content.findById(photo._id);
        })
        .then((saved) => expect(saved).to.not.eql(null));
    });

    it('does not show one user the photos of another', () => {
      return request.execute(baseUri).get('/getAll').set({ token: bobToken })
        .then((res) => expect(res.body).to.eql([]));
    });

    it('answers 404 for an id that is not an id', () => {
      return request.execute(baseUri).delete('/delete/not-an-id').set({ token: aliceToken })
        .then((res) => expect(res).to.have.status(404));
    });
  });

  describe('accounts', () => {
    it('does not allow two accounts with the same email, in any case', () => {
      return request.execute(baseUri).post('/signup').send({ email: 'Alice@Tester.com ', password: 'password9' })
        .then((res) => expect(res).to.have.status(409));
    });

    it('signs in with a password containing a colon', () => {
      return makeUser('colon@tester.com', 'pass:word:1')
        .then(() => request.execute(baseUri).get('/signin').auth('colon@tester.com', 'pass:word:1'))
        .then((res) => expect(res).to.have.status(200));
    });

    it('gives the same answer for an unknown email and a wrong password', () => {
      return Promise.all([
        request.execute(baseUri).get('/signin').auth('nobody@tester.com', 'password1'),
        request.execute(baseUri).get('/signin').auth('alice@tester.com', 'wrongpassword')
      ]).then((results) => {
        expect(results[0]).to.have.status(401);
        expect(results[0].body).to.eql(results[1].body);
      });
    });

    it('ignores operators in a settings update', () => {
      return request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: aliceToken })
        .send({ $set: { email: 'hijacked@tester.com' } })
        .then((res) => {
          expect(res).to.have.status(400);
          return User.findById(alice._id);
        })
        .then((saved) => expect(saved.email).to.eql('alice@tester.com'));
    });

    it('needs the current password to change the password', () => {
      return request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: aliceToken })
        .send({ password: 'newpassword' })
        .then((res) => expect(res).to.have.status(403));
    });

    it('does not let one user change another user\'s account', () => {
      return request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: bobToken })
        .send({ email: 'bob2@tester.com', currentPassword: 'password2' })
        .then((res) => expect(res).to.have.status(403));
    });

    it('signs out old sessions when the password changes', function() {
      // Tokens record their issue time in whole seconds.
      this.timeout(5000);
      var newToken;
      return new Promise((resolve) => setTimeout(resolve, 1100))
        .then(() => request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: aliceToken })
          .send({ password: 'newpassword', currentPassword: 'password1' }))
        .then((res) => {
          expect(res).to.have.status(200);
          newToken = res.body.token;
          return request.execute(baseUri).get('/getAll').set({ token: aliceToken });
        })
        .then((res) => {
          expect(res).to.have.status(401);
          return request.execute(baseUri).get('/getAll').set({ token: newToken });
        })
        .then((res) => expect(res).to.have.status(200));
    });

    it('deletes a user\'s photos along with the account', () => {
      return Content.create({ user_id: alice._id, content: 'data:image/png;base64,AAAA' })
        .then(() => request.execute(baseUri).delete('/deleteuser/' + alice._id).set({ token: aliceToken })
          .send({ currentPassword: 'password1' }))
        .then((res) => {
          expect(res).to.have.status(200);
          return Content.countDocuments({ user_id: alice._id });
        })
        .then((count) => expect(count).to.eql(0));
    });
  });

  describe('account details', () => {
    ['plainaddress', 'no@tld', 'a b@tester.com', 'x@' + 'y'.repeat(250) + '.com'].forEach((email) => {
      it('refuses to sign up with the email ' + email.slice(0, 20), () => {
        return request.execute(baseUri).post('/signup').send({ email: email, password: 'password9' })
          .then((res) => {
            expect(res).to.have.status(400);
            expect(res.body.msg).to.match(/valid email/);
          });
      });
    });

    it('refuses a password longer than bcrypt can use', () => {
      return request.execute(baseUri).post('/signup')
        .send({ email: 'long@tester.com', password: 'é'.repeat(37) })
        .then((res) => {
          expect(res).to.have.status(400);
          expect(res.body.msg).to.match(/at most 72 bytes/);
        });
    });

    it('refuses a bad email or password in a settings change', () => {
      return request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: aliceToken })
        .send({ email: 'not-an-email', currentPassword: 'password1' })
        .then((res) => {
          expect(res).to.have.status(400);
          return request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: aliceToken })
            .send({ password: 'x'.repeat(73), currentPassword: 'password1' });
        })
        .then((res) => expect(res).to.have.status(400));
    });

    it('hashes new passwords at cost 12', () => {
      return User.findById(alice._id).then((user) => expect(bcrypt.getRounds(user.password)).to.eql(12));
    });

    it('still signs in with an old cost-8 hash, and upgrades it', function() {
      this.timeout(10000);
      return User.collection.updateOne({ _id: alice._id }, { $set: { password: bcrypt.hashSync('password1', 8) } })
        .then(() => request.execute(baseUri).get('/signin').auth('alice@tester.com', 'password1'))
        .then((res) => {
          expect(res).to.have.status(200);
          // The upgrade is saved after the reply.
          return new Promise((resolve) => setTimeout(resolve, 1000));
        })
        .then(() => User.findById(alice._id))
        .then((user) => {
          expect(bcrypt.getRounds(user.password)).to.eql(12);
          // An upgrade isn't a password change, so other sessions stay signed in.
          return request.execute(baseUri).get('/getAll').set({ token: aliceToken });
        })
        .then((res) => expect(res).to.have.status(200));
    });

    it('signs in to a legacy account saved with a mixed-case email', function() {
      this.timeout(10000);
      return User.collection.updateOne({ _id: alice._id }, { $set: { email: 'Alice@Tester.com' } })
        .then(() => request.execute(baseUri).get('/signin').auth('alice@tester.com', 'password1'))
        .then((res) => {
          expect(res).to.have.status(200);
          return request.execute(baseUri).get('/signin').auth('ALICE@tester.com', 'password1');
        })
        .then((res) => expect(res).to.have.status(200));
    });

    it('does not treat an email as a pattern when ignoring case', () => {
      return request.execute(baseUri).get('/signin').auth('.*@tester.com', 'password1')
        .then((res) => expect(res).to.have.status(401));
    });

    it('takes about as long for an unknown email as for a wrong password', function() {
      this.timeout(10000);
      const time = (email) => {
        const start = Date.now();
        return request.execute(baseUri).get('/signin').auth(email, 'wrongpassword')
          .then((res) => {
            expect(res).to.have.status(401);
            return Date.now() - start;
          });
      };
      return time('alice@tester.com').then((known) => time('nobody@tester.com')
        .then((unknown) => expect(unknown).to.be.above(known / 3)));
    });
  });

  describe('email migration script', () => {
    it('lowercases emails and reports ones that clash', () => {
      return User.collection.insertMany([
        { email: 'Carol@Tester.com', password: 'x' },
        { email: 'DAVE@tester.com', password: 'x' }
      ])
        .then(() => User.collection.updateOne({ _id: bob._id }, { $set: { email: 'ALICE@tester.com' } }))
        .then(() => migrateEmails.migrate(User.collection, { dryRun: true }))
        .then((result) => {
          expect(result.updated).to.eql(2);
          return User.countDocuments({ email: 'carol@tester.com' });
        })
        .then((count) => {
          expect(count, 'a dry run changes nothing').to.eql(0);
          return migrateEmails.migrate(User.collection);
        })
        .then((result) => {
          expect(result.updated).to.eql(2);
          expect(result.duplicates).to.have.length(1);
          expect(result.duplicates[0].slice().sort()).to.eql(['ALICE@tester.com', 'alice@tester.com']);
          return User.collection.countDocuments({ email: { $in: ['carol@tester.com', 'dave@tester.com'] } });
        })
        .then((count) => expect(count).to.eql(2));
    });
  });

  describe('rate limits', () => {
    it('slows down repeated sign-in attempts from one address', function() {
      this.timeout(20000);
      const attempts = [];
      for (let i = 0; i < 6; i++) {
        attempts.push(() => request.execute(baseUri).get('/signin').auth('nobody@tester.com', 'password1'));
      }
      return attempts.reduce((p, attempt) => p.then((list) => attempt().then((res) => list.concat([res]))),
        Promise.resolve([]))
        .then((results) => {
          expect(results.slice(0, 5).map((r) => r.status)).to.eql([401, 401, 401, 401, 401]);
          expect(results[5]).to.have.status(429);
          expect(Number(results[5].headers['retry-after'])).to.be.above(0);
          // Sign-ups share the same allowance.
          return request.execute(baseUri).post('/signup').send({ email: 'new@tester.com', password: 'password9' });
        })
        .then((res) => expect(res).to.have.status(429));
    });

    it('limits wrong passwords for an account, from any address', async function() {
      this.timeout(30000);
      // Each from a different address, as far as the per-address limit knows.
      const signIn = (email, password) => {
        authRouter.rateLimiter.reset();
        return request.execute(baseUri).get('/signin').auth(email, password);
      };
      for (let i = 0; i < 10; i++) expect(await signIn('alice@tester.com', 'wrong' + i)).to.have.status(401);
      const refused = await signIn('alice@tester.com', 'password1');
      expect(refused).to.have.status(429);
      expect(refused.body.msg).to.match(/wrong passwords for this email/);
      expect(await signIn('bob@tester.com', 'password2')).to.have.status(200);
    });

    it('limits guesses at the current password, for each account', function() {
      this.timeout(20000);
      const guess = (i) => request.execute(baseUri).put('/usersettings/' + alice._id).set({ token: aliceToken })
        .send({ email: 'alice2@tester.com', currentPassword: 'wrong' + i });
      return [0, 1, 2, 3, 4, 5].reduce((p, i) => p.then((list) => guess(i).then((res) => list.concat([res]))),
        Promise.resolve([]))
        .then((results) => {
          expect(results.slice(0, 5).map((r) => r.status)).to.eql([403, 403, 403, 403, 403]);
          expect(results[5]).to.have.status(429);
          // From another address too: the account's allowance is used up.
          userRouter.addressTries.reset();
          return request.execute(baseUri).delete('/deleteuser/' + alice._id).set({ token: aliceToken })
            .send({ currentPassword: 'password1' });
        })
        .then((res) => {
          expect(res).to.have.status(429);
          return User.countDocuments({ _id: alice._id });
        })
        .then((count) => expect(count).to.eql(1));
    });

    it('counts an IPv6 address by its /64 network', () => {
      expect(rateLimit.clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).to.eql('2001:db8:1:2::/64');
      expect(rateLimit.clientKey('2001:0db8:0001:0002::1')).to.eql('2001:db8:1:2::/64');
      expect(rateLimit.clientKey('2001:db8::1')).to.eql('2001:db8:0:0::/64');
      expect(rateLimit.clientKey('::ffff:203.0.113.7')).to.eql('203.0.113.7');
      expect(rateLimit.clientKey('203.0.113.7')).to.eql('203.0.113.7');
      expect(rateLimit.clientKey('2001:db8:1:2:aaaa::1', 48)).to.eql('2001:db8:1::/48');
      expect(rateLimit.clientKey('203.0.113.7', 48)).to.eql('203.0.113.7');
      const limiter = rateLimit({ perMinute: 1, burst: 1, now: () => 0 });
      const statuses = [];
      for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:3::1']) {
        var status = 200;
        const res = { set: () => res, status: (s) => { status = s; return res; }, json: () => res };
        limiter({ ip: ip }, res, () => {});
        statuses.push(status);
      }
      expect(statuses).to.eql([200, 429, 200]);
    });

    it('refills over time and forgets idle clients', () => {
      var clock = 0;
      const limiter = rateLimit({ perMinute: 60, burst: 2, now: () => clock });
      const statuses = [];
      const hit = (ip) => {
        var status = 200;
        const res = { set: () => res, status: (s) => { status = s; return res; }, json: () => res };
        limiter({ ip: ip }, res, () => {});
        statuses.push(status);
      };
      hit('a'); hit('a'); hit('a');
      clock += 1000; // one more token after a second
      hit('a'); hit('a');
      hit('b');
      expect(statuses).to.eql([200, 200, 429, 200, 429, 200]);
      expect(limiter.size()).to.eql(2);
      clock += 120000;
      hit('c');
      expect(limiter.size()).to.eql(1);
    });
  });

  describe('headers', () => {
    it('sends a Content Security Policy, and no X-Powered-By', () => {
      return request.execute(baseUri).get('/settings').then((res) => {
        expect(res).to.have.status(200);
        expect(res.headers).to.not.have.property('x-powered-by');
        const csp = res.headers['content-security-policy'];
        expect(csp).to.match(/script-src 'self'/);
        expect(csp).to.match(/frame-ancestors 'none'/);
        expect(csp).to.match(/object-src 'none'/);
        expect(csp).to.not.match(/unsafe-eval/);
        expect(res.headers['x-content-type-options']).to.eql('nosniff');
        expect(res.headers['permissions-policy']).to.match(/camera=\(self\)/);
      });
    });

    it('allows the built page\'s own inline scripts by hash, and where its API is', () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'csp-')), 'index.html');
      fs.writeFileSync(file, '<meta name="omnifilter-api" content="https://api.example.com/v1">' +
        '<script src="main.js" type="module"></script><script>go()</script>');
      const page = require(__dirname + '/../lib/security_headers').readPage(file);
      expect(page.hashes).to.eql(['\'sha256-' + require('crypto').createHash('sha256').update('go()')
        .digest('base64') + '\'']);
      expect(page.api).to.eql(['https://api.example.com']);
      fs.writeFileSync(file, '<meta name="omnifilter-api" content="/">');
      expect(require(__dirname + '/../lib/security_headers').readPage(file).api).to.eql([]);
    });
  });

  describe('CORS', () => {
    it('allows the client\'s origin and answers a preflight', () => {
      return request.execute(baseUri).options('/signin').set('Origin', 'http://localhost:5000')
        .then((res) => {
          expect(res).to.have.status(204);
          expect(res.headers['access-control-allow-origin']).to.eql('http://localhost:5000');
          expect(res.headers.vary).to.match(/Origin/);
        });
    });

    it('does not allow other origins', () => {
      return request.execute(baseUri).get('/filters').set('Origin', 'https://evil.example')
        .then((res) => {
          expect(res).to.have.status(200);
          expect(res.headers).to.not.have.property('access-control-allow-origin');
          expect(res.headers.vary).to.match(/Origin/);
        });
    });
  });

  describe('image size limits', () => {
    it('refuses images over the pixel limit without decoding them', function() {
      this.timeout(20000);
      // 8000 x 8000 is 64 megapixels: a few hundred KB as a PNG, 256 MB decoded.
      return pngDataUrl(8000, 8000)
        .then((content) => {
          const start = Date.now();
          return imageCodec.decodeDataUrl(content).then(
            () => { throw new Error('should have been refused'); },
            (err) => {
              expect(err.message).to.include('megapixels');
              expect(Date.now() - start).to.be.below(1000);
            });
        });
    });

    it('refuses images wider than the GPU can texture', () => {
      return pngDataUrl(imageCodec.MAX_SIDE + 1, 1)
        .then((content) => imageCodec.decodeDataUrl(content))
        .then(() => { throw new Error('should have been refused'); },
          (err) => expect(err.message).to.include('pixels wide or tall'));
    });

    it('answers an oversized image with a 400', function() {
      this.timeout(20000);
      return pngDataUrl(8000, 8000)
        .then((content) => request.execute(baseUri).post('/newcontent').set({ token: aliceToken })
          .send({ content: content, tOption: 'invert' }))
        .then((res) => {
          expect(res).to.have.status(400);
          expect(res.body.msg).to.include('megapixels');
        });
    });
  });
});
