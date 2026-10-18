const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const secret = require(__dirname + '/../lib/secret');

// Logins last a week, then the user signs in again.
const TOKEN_LIFETIME = '7d';

// bcrypt work factor. Each step doubles the time a hash takes (12 is about
// 200ms). Hashes record their own cost, so older cost-8 hashes still verify,
// and they are upgraded the next time their owner signs in. The native
// bcrypt hashes on libuv's thread pool, so a sign-in doesn't hold up other
// requests meanwhile (bcryptjs, which made the older hashes and whose hashes
// it reads, ran on the main thread).
const BCRYPT_COST = 12;

// Compared against when there is no such user, so that an unknown email
// takes as long to refuse as a wrong password. (The cost-12 hash of a random
// string that was thrown away.)
const DUMMY_HASH = '$2a$12$QyCu3yJCX8dkIdux4mHpJOLBsU6nnZ/lFk6eVXDOOJ2dXPGq.pJR.';

var userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  // Tokens issued before this are rejected, so changing the password signs
  // out every other session.
  passwordChangedAt: Date,
  // Tokens issued before this, or in the same second, are rejected too:
  // "Sign out of all devices" (user_routes.js).
  signedOutAt: Date
});

// Resolves once the password is hashed. Saving also waits for a hash still in
// progress, so `user.hashPassword(pw); user.save()` works too.
// rehash: true just upgrades the hash of the same password, so it leaves
// passwordChangedAt (and so the user's other sessions) alone.
userSchema.methods.hashPassword = function(password, options) {
  const rehash = Boolean(options && options.rehash);
  const pending = bcrypt.hash(password, BCRYPT_COST).then((hash) => {
    this.password = hash;
    if (!rehash) this.passwordChangedAt = new Date();
    return hash;
  });
  this.$locals.pendingHash = pending;
  return pending;
};

userSchema.pre('validate', function() {
  const pending = this.$locals.pendingHash;
  delete this.$locals.pendingHash;
  return pending;
});

// Resolves with whether the password matches.
userSchema.methods.comparePassword = function(password) {
  if (typeof password !== 'string') return Promise.resolve(false);
  return bcrypt.compare(password, this.password);
};

// Whether the stored hash was made with a lower cost than BCRYPT_COST.
userSchema.methods.needsRehash = function() {
  try {
    return bcrypt.getRounds(this.password) < BCRYPT_COST;
  } catch (e) {
    return false;
  }
};

userSchema.methods.generateToken = function() {
  return jwt.sign({ id: String(this._id) }, secret,
    { algorithm: 'HS256', expiresIn: TOKEN_LIFETIME });
};

// Spends as long as comparePassword would, for a sign-in with no such user.
userSchema.statics.dummyCompare = function(password) {
  return bcrypt.compare(typeof password === 'string' ? password : '', DUMMY_HASH).then(() => false);
};

const User = module.exports = exports = mongoose.model('User', userSchema);

exports.BCRYPT_COST = BCRYPT_COST;

// Emails are stored lowercase and unique. Data from before that may have
// mixed-case duplicates, which stop the unique index from building; see
// scripts/migrate-emails.js.
User.init().catch((err) => {
  console.log('WARNING: could not build the unique email index (' + err.message + '). ' +
    'Run `node scripts/migrate-emails.js` to find duplicate emails.');
});
