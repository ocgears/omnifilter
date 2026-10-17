#!/usr/bin/env node
// Puts a test run's coverage (an Istanbul coverage-summary.json, as c8 and
// Vitest write it) on the GitHub Actions run: an annotation and a line on
// the summary page.
//   node .github/coverage-summary.js <name> <coverage-summary.json>
'use strict';

const fs = require('fs');

const [name, file] = process.argv.slice(2);
const total = JSON.parse(fs.readFileSync(file, 'utf8')).total;
const parts = ['lines', 'statements', 'branches', 'functions']
  .map((k) => k + ' ' + total[k].pct + '%');
const line = name + ' coverage: ' + parts.join(', ');
console.log(line);
if (process.env.GITHUB_ACTIONS) {
  console.log('::notice title=Coverage (' + name + ')::' + parts.join(', '));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '- ' + line + '\n');
}
