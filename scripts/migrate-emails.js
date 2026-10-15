#!/usr/bin/env node
'use strict';

// Lowercases the email of every account, so that sign-in (which looks emails
// up in lowercase) and the unique email index work for accounts made before
// emails were stored that way. Emails that differ only in case belong to
// separate accounts that would clash, so those are left alone and reported,
// to be merged or removed by hand; then run this again.
//
//   node scripts/migrate-emails.js            make the changes
//   node scripts/migrate-emails.js --dry-run  only report what it would do
//
// Uses MONGOLAB_URI, like the server.

const mongoose = require('mongoose');

// Resolves with { updated, duplicates: [[email, ...], ...] }. users is the
// raw users collection, so no schema setters or index builds get in the way.
async function migrate(users, options) {
  const dryRun = Boolean(options && options.dryRun);
  const groups = await users.aggregate([
    { $match: { email: { $type: 'string' } } },
    { $group: {
      _id: { $toLower: { $trim: { input: '$email' } } },
      accounts: { $push: { id: '$_id', email: '$email' } }
    } }
  ]).toArray();

  var updated = 0;
  const duplicates = [];
  for (const group of groups) {
    if (group.accounts.length > 1) {
      duplicates.push(group.accounts.map((a) => a.email));
      continue;
    }
    const account = group.accounts[0];
    if (account.email === group._id) continue;
    if (!dryRun) await users.updateOne({ _id: account.id }, { $set: { email: group._id } });
    updated++;
  }
  return { updated: updated, duplicates: duplicates };
}

module.exports = exports = { migrate: migrate };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const uri = process.env.MONGOLAB_URI || 'mongodb://localhost/omnifilter_app_dev';
  mongoose.connect(uri)
    .then(() => migrate(mongoose.connection.db.collection('users'), { dryRun: dryRun }))
    .then((result) => {
      console.log((dryRun ? 'Would lowercase ' : 'Lowercased ') + result.updated + ' email' +
        (result.updated === 1 ? '' : 's') + '.');
      if (result.duplicates.length) {
        console.log('These accounts share an email apart from case; merge or remove them by hand:');
        for (const emails of result.duplicates) console.log('  ' + emails.join(', '));
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Migration failed: ' + err.message);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
