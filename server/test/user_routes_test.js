require(__dirname + '/../server');
const { clearCollections } = require(__dirname + '/setup');
const chai = require('chai');
const chaiHttp = require('chai-http');
chai.use(chaiHttp);
const expect = chai.expect;
const request = chai.request;
const mongoose = require('mongoose');
var PORT = process.env.PORT || process.env.$PORT || 3000;
var baseUri = 'localhost:' + PORT;
const User = require(__dirname + '/../models/user');
var userToken;
var testUser;

describe('user API', () => {

  before((done) => {
    testUser = new User();
    testUser.email = 'test3@tester.com';
    testUser.hashPassword('password');
    testUser.save().then((data) => {
      testUser.token = userToken = data.generateToken();
      done();
    }, done);
  });

  after((done) => {
    clearCollections().then(() => done(), done);
  });

  describe('check if user exists', () => {
    it('should be able to verify that a user exists', (done) => {
      request(baseUri)
        .get('/verify/')
        .set('token', userToken)
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res.body).to.not.eql(null);
          expect(res.body.msg).to.eql('User verified');
          done();
        });
    });
  });

  describe('ability to UPDATE and DELETE', () => {
    it('should be able to UPDATE a user', (done) => {
      request(baseUri)
        .put('/usersettings/' + testUser._id)
        .set('token', userToken)
        .send({ email: 'new@tester.com', currentPassword: 'password' })
        .end(function(err, res) {
          expect(err).to.eql(null);
          expect(res.body.msg).to.eql('User updated');
          expect(res).to.have.status(200);
          done();
        });
    });

    it('should not DELETE a user without the current password', () => {
      return request(baseUri)
        .delete('/deleteuser/' + testUser._id)
        .set('token', userToken)
        .then((res) => {
          expect(res).to.have.status(403);
          return request(baseUri).delete('/deleteuser/' + testUser._id).set('token', userToken)
            .send({ currentPassword: 'wrongpassword' });
        })
        .then((res) => {
          expect(res).to.have.status(403);
          expect(res.body.msg).to.eql('Your current password is incorrect');
          return User.countDocuments({ _id: testUser._id });
        })
        .then((count) => expect(count).to.eql(1));
    });

    it('should be able to DELETE a user', (done) => {
      request(baseUri)
        .delete('/deleteuser/' + testUser._id)
        .set('token', userToken)
        .send({ currentPassword: 'password' })
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res.body.msg).to.eql('User deleted');
          expect(res).to.have.status(200);
          done();
        });
    });

    it('answers a settings change for a deleted account with a 401', () => {
      return request(baseUri)
        .put('/usersettings/' + testUser._id)
        .set('token', userToken)
        .send({ email: 'gone@tester.com', currentPassword: 'password' })
        .then((res) => expect(res).to.have.status(401));
    });
  });
});
