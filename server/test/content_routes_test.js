process.env.MONGOLAB_URI = 'mongodb://localhost/content_routes_test';
require(__dirname + '/../server.js');
const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;

var chai = require('chai');
var chaiHTTP = require('chai-http');
chai.use(chaiHTTP);
var mongoose = require('mongoose');
var expect = chai.expect;

describe('content API', () => {

  var userToken;
  var userId;

  before((done) => {
    var newUser = new User();
    newUser.email = 'test@tester.com';
    newUser.hashPassword('password');
    newUser.save((err, data) => {
      if (err) return console.log('Error in the before section of the test with : ' + err);
      userToken = data.generateToken();
      userId = data._id;
      done();
    });
  });

  after((done) => {
    mongoose.connection.db.dropDatabase(() => {
      done();
    });
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

  it('should create content with a POST', (done) => {
    chai.request(baseUri)
      .post('/newcontent')
      .set( { token: userToken } )
      .send({ content: 'content' } )
      .end(function(err, res) {
        expect(err).to.eql(null);
        expect(res).to.have.status(200);
        expect(res.body.content).to.eql('content');
        expect(res.body).to.have.property('_id');
        done();
      });
  });

  describe('rest requests that require content already in db', () => {
    beforeEach((done) => {
      Content.create( { content: 'test content', user_id: userId }, (err, data) => {
        if (err) throw new Error('Error', err);
        this.testContent = data;
        done();
      });
    });

    it('should be able to update content', (done) => {
      chai.request(baseUri)
        .put('/preview/' + this.testContent._id)
        .set( { token: userToken } )
        .send( { name: 'new content name' } )
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body.msg).to.eql('Successfully updated content');
          done();
        });
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
          expect(err).to.not.eql(null);
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
          expect(err).to.not.eql(null);
          expect(res).to.have.status(404);
          done();
        });
    });
  });
});
