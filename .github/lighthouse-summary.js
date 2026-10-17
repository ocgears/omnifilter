#!/usr/bin/env node
// Puts the Lighthouse results (lighthouse-report/manifest.json, written by
// `lhci autorun`) on the GitHub Actions run's summary page: each page's
// scores and main timings, from its representative run.
'use strict';

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'lighthouse-report');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

const score = (s) => (s === null || s === undefined ? '–' : Math.round(s * 100));
const seconds = (audit) => (audit ? (audit.numericValue / 1000).toFixed(1) + ' s' : '–');

const rows = ['| Page | Performance | Accessibility | Best practices | SEO | First paint | Largest paint | Blocking | Layout shift |',
  '|---|---|---|---|---|---|---|---|---|'];
for (const run of manifest.filter((r) => r.isRepresentativeRun)) {
  const report = JSON.parse(fs.readFileSync(run.jsonPath, 'utf8'));
  const a = report.audits;
  const page = new URL(run.url).hash || '/';
  rows.push('| ' + [
    page,
    score(run.summary.performance),
    score(run.summary.accessibility),
    score(run.summary['best-practices']),
    score(run.summary.seo),
    seconds(a['first-contentful-paint']),
    seconds(a['largest-contentful-paint']),
    Math.round(a['total-blocking-time'].numericValue) + ' ms',
    a['cumulative-layout-shift'].numericValue.toFixed(3)
  ].join(' | ') + ' |');
  // The same as an annotation, which shows on the run's page (and in the
  // API) without opening the summary.
  if (process.env.GITHUB_ACTIONS) {
    console.log('::notice title=Lighthouse ' + page + '::performance ' + score(run.summary.performance) +
      ', FCP ' + seconds(a['first-contentful-paint']) + ', LCP ' + seconds(a['largest-contentful-paint']) +
      ', TBT ' + Math.round(a['total-blocking-time'].numericValue) + ' ms, CLS ' +
      a['cumulative-layout-shift'].numericValue.toFixed(3));
  }
}

const text = '## Lighthouse (mobile)\n\n' + rows.join('\n') + '\n';
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
