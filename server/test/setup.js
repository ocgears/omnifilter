// Loaded before the test files (see "test" in package.json). All suites share
// one server and so one database connection, made when server.js is first
// required, so the database is set here once rather than per file.
process.env.MONGOLAB_URI = process.env.MONGOLAB_URI || 'mongodb://localhost/omnifilter_test';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const mongoose = require('mongoose');

// Suites empty the collections when they finish. Emptying rather than dropping
// keeps indexes such as the unique email; the whole test database goes once
// everything has run.
exports.clearCollections = () => Promise.all(
  ['User', 'Content'].filter((name) => mongoose.models[name])
    .map((name) => mongoose.models[name].deleteMany({})));

// A kept photo itself (GET /content/:id), as a data URL.
exports.keptPhoto = (baseUri, token, id) => {
  const { request } = require('chai-http');
  return request.execute(baseUri).get('/content/' + id).set({ token: token })
    .buffer(true).parse((res, done) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    })
    .then((res) => {
      if (res.status !== 200) throw new Error('GET /content/' + id + ': ' + res.status);
      return 'data:' + res.headers['content-type'].split(';')[0] + ';base64,' + res.body.toString('base64');
    });
};

after(() => {
  if (mongoose.connection.db) return mongoose.connection.db.dropDatabase();
});
