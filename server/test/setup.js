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

after(() => {
  if (mongoose.connection.db) return mongoose.connection.db.dropDatabase();
});
