// Loaded with NODE_OPTIONS=--require by host_test.js: kills check-device's
// child process before it reports a device, as a driver crash while compiling
// the kernels would.
if (process.argv[2] === '--child') process.kill(process.pid, 'SIGKILL');
