// Starts each end-to-end run with no accounts or photos. The collections are
// emptied rather than the database dropped, which would also drop the unique
// email index the server built when it started.
const mongoose = require('mongoose');

module.exports = async () => {
  const uri = process.env.E2E_MONGO_URI || 'mongodb://localhost/omnifilter_e2e';
  const connection = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    for (const name of ['users', 'contents']) {
      await connection.collection(name).deleteMany({});
    }
  } finally {
    await connection.close();
  }
};
