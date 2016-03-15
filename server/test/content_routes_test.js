const chai = require('chai');
const chaiHttp = require('chai-http');
chai.use(chaiHttp);
const expect = chai.expect;
const mongoose = require('mongoose');
process.env.MONGOLAB_URI = 'mongodb://localhost/content_app_test';
const server = require(__dirname + '/../server');
const Content = require(__dirname + '/../models/content');
const User = require(__dirname + '/../models/user');


describe('content API', () => {

  var userToken;
  var userId;

  before((done) => {
    var newUser = new User();
    newUser.email = 'gene@gmail.com';
    newUser.hashPassword('password');
    newUser.save((err, data) => {
      if(err) return console.log('Error in the before section of the test with : ' + err);
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
    chai.request('localhost:3000')
      .get('/getall')
      .set({token: userToken})
      .end((err, res) => {
        expect(err).to.eql(null);
        expect(res.body).to.not.eql(null);
        done();
      });
  });

  it('should create content with a POST', (done) => {
    chai.request('localhost:3000')
      .post('/newcontent')
      .set({token: userToken})
      .send({content: 'content'})
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
      Content.create({content: 'test content', user_id: userId}, (err, data) => {
        this.testContent = data;
        done();
      });
    });

    it('should be able to update content', (done) => {
      chai.request('localhost:3000')
        .put('/preview/' + this.testContent._id)
        .set({token: userToken})
        .send({name: 'new content name'})
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body.msg).to.eql('Successfully updated content');
          done();
        });
    });

    it('should be able to delete content', (done) => {
      chai.request('localhost:3000')
        .delete('/delete/' + this.testContent._id)
        .set({token: userToken})
        .end((err, res) => {
          expect(err).to.eql(null);
          expect(res).to.have.status(200);
          expect(res.body.msg).to.eql('Successfully deleted content');
          done();
        });
    });
  });
});
