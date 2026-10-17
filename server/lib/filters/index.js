'use strict';

const { roundWholeParams } = require('./plan');

// Every filter, in the order the UI lists them. Each definition has:
//   name, label, group, description
//   params:  controls the client renders (see range() / choice() in plan.js)
//   plan(width, height, params) -> Plan   for filters that run as OpenCL passes
//   run({ rgba, width, height, params }) -> Promise<Buffer>   for anything else
//   workingSize(params) -> pixels   optional: run on a copy scaled down so its
//                                   longer side is at most this
// Whole-number parameters reach plan(), run() and workingSize() rounded.
const definitions = [].concat(
  require('./blur'),
  require('./edges'),
  require('./colour'),
  require('./looks'),
  require('./cube_looks'),
  require('./stylize'),
  require('./retro'),
  require('./distort'),
  require('./adjust'),
  require('./generative'),
  require('./neural')
);

module.exports = definitions.map((def) => {
  const rounded = Object.assign({}, def);
  if (def.plan) rounded.plan = (w, h, p) => def.plan(w, h, roundWholeParams(def.params, p));
  if (def.run) {
    rounded.run = (job) => def.run(Object.assign({}, job, { params: roundWholeParams(def.params, job.params) }));
  }
  if (def.workingSize) rounded.workingSize = (p) => def.workingSize(roundWholeParams(def.params, p));
  return rounded;
});
