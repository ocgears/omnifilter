process.env.MONGOLAB_URI = 'mongodb://localhost/auth_routes_test';
require(__dirname + '/../server.js');
const User = require(__dirname + '/../models/user');
var baseUri = 'localhost:3000';

var chai = require('chai');
var chaiHTTP = require('chai-http');
chai.use(chaiHTTP);
var mongoose = require('mongoose');
var expect = chai.expect;

var userId;
var userToken;

describe('authorization route', () => {
  after((done) => {
    mongoose.connection.db.dropDatabase(() => {
      done();
    });
  });
  it('should create a new user with a POST request', (done) => {
    chai.request(baseUri)
      .post('/signup')
      .send( { 'email': 'gene@gmail.com', 'password': 'password' } )
      .end((err, res) => {
        expect(err).to.eql(null);
        expect(res).to.have.status(200);
        expect(res.body).to.have.property('token');
        expect(res.body).to.have.property('email');
        done();
      });
  });
  describe('rest requests that require an existing user in the DB', () => {
    beforeEach((done) => {
      var newUser = new User();
      newUser.email = 'gene@gmail.com';
      newUser.hashPassword('password');
      newUser.save((err, data) => {
        if (err) throw err;
        userToken = data.generateToken();
        userId = data._id;
        expect(err).to.eql(null);
        expect(userToken).to.not.eql(null);
        expect(userId).to.not.eql(null);
        done();
      });
    });
    it('should check if the user has valid credentials', (done) => {
      chai.request(baseUri)
        .get('/signin')
        .auth('gene@gmail.com', 'password')
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body).to.have.property('token');
          expect(res.body).to.have.property('email');
          done();
        });
    });
    it('should not allow user to enter a bad password', (done) => {
      chai.request(baseUri)
        .get('/signin')
        .auth('gene@gmail.com', 'NOTpassword')
        .end((err, res) => {
          expect(err).to.not.eql(null);
          expect(res).to.have.status(401);
          expect(res.body).to.not.have.property('token');
          expect(res.body).to.not.have.property('email');
          done();
        });
    });
  });
});
