require(__dirname + '/../server.js');
const { clearCollections } = require(__dirname + '/setup');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
const imageCodec = require(__dirname + '/../lib/image_codec');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var chaiHTTP = require('chai-http');
chai.use(chaiHTTP);
var mongoose = require('mongoose');
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
    chai.request(baseUri)
      .get('/getAll')
      .set( { token: userToken } )
      .end((err, res) => {
        expect(err).to.eql(null);
        expect(res.body).to.not.eql(null);
        done();
      });
  });

  it('should create content with a POST', () => {
    return pngDataUrl().then((content) => chai.request(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: content } )
      .then((res) => {
        expect(res).to.have.status(200);
        expect(res.body.content).to.eql(content);
        expect(res.body).to.have.property('_id');
      }));
  });

  it('labels a photo saved as is with the format it really is', () => {
    return pngDataUrl().then((content) => chai.request(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: content.replace('image/png', 'image/jpeg') } )
      .then((res) => {
        expect(res).to.have.status(200);
        expect(res.body.content).to.eql(content);
      }));
  });

  it('refuses to save something that only claims to be an image', () => {
    return chai.request(baseUri)
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
    return chai.request(baseUri)
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
    return pngDataUrl().then((content) => chai.request(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: content } ))
      .then((res) => {
        expect(res).to.have.status(413);
        expect(res.body.msg).to.match(/too large/);
      })
      .finally(() => { imageCodec.MAX_DATA_URL_LENGTH = limit; });
  });

  describe('rest requests that require content already in db', () => {
    beforeEach((done) => {
      Content.create( { content: 'test content', user_id: userId }).then((data) => {
        this.testContent = data;
        done();
      }, done);
    });

    it('should be able to update content', (done) => {
      chai.request(baseUri)
        .put('/preview/' + this.testContent._id)
        .set( { token: userToken } )
        .send( { title: 'new content name' } )
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body.msg).to.eql('Successfully updated content');
          Content.findById(this.testContent._id).then((saved) => {
            expect(saved.title).to.eql('new content name');
            done();
          }, done);
        });
    });

    it('answers an update with no editable fields with a 400', () => {
      return chai.request(baseUri)
        .put('/preview/' + this.testContent._id)
        .set( { token: userToken } )
        .send( { name: 'not a field' } )
        .then((res) => {
          expect(res).to.have.status(400);
          expect(res.body.msg).to.eql('Nothing to update');
        });
    });

    [
      [{ title: 'x'.repeat(201) }, /title can be at most 200/],
      [{ location: 'x'.repeat(201) }, /location can be at most 200/],
      [{ tags: new Array(51).fill('tag') }, /At most 50 tags/],
      [{ tags: ['x'.repeat(51)] }, /At most 50 tags/],
      [{ tags: 'not a list' }, /list of strings/]
    ].forEach((pair) => {
      it('refuses ' + Object.keys(pair[0])[0] + ' that is too long or the wrong shape', () => {
        return chai.request(baseUri)
          .put('/preview/' + this.testContent._id)
          .set( { token: userToken } )
          .send(pair[0])
          .then((res) => {
            expect(res).to.have.status(400);
            expect(res.body.msg).to.match(pair[1]);
          });
      });
    });

    it('accepts fields at their length limits', () => {
      return chai.request(baseUri)
        .put('/preview/' + this.testContent._id)
        .set( { token: userToken } )
        .send( { title: 'x'.repeat(200), tags: new Array(50).fill('y'.repeat(50)) } )
        .then((res) => expect(res).to.have.status(200));
    });

    it('refuses a large body when updating a photo\'s details', () => {
      return chai.request(baseUri)
        .put('/preview/' + this.testContent._id)
        .set( { token: userToken } )
        .send( { title: 'ok', padding: 'x'.repeat(200 * 1024) } )
        .then((res) => expect(res).to.have.status(413));
    });

    it('should be able to delete content', (done) => {
      chai.request(baseUri)
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
  describe('Error handling in preview route', () => {
    it('should correctly stop for lack of token', (done) => {
      chai.request(baseUri)
        .put('/preview/' + this.testContent._id)
        .set( { token: null } )
        .send( { name: 'new content name' } )
        .end((err, res) => {
          expect(res).to.have.status(401);
          expect(res.body.msg).to.eql('could not authenticate user');
          done();
        });
    });

    it('should correctly stop for mis-match verb', (done) => {
      chai.request(baseUri)
        .get('/preview/' + this.testContent._id)
        .set( { token: userToken } )
        .send( { name: 'new content name' } )
        .end((err, res) => {
          expect(res).to.have.status(404);
          done();
        });
    });
  });
});
