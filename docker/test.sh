#!/usr/bin/env bash
# Runs the test suites in the CI image (docker/ci.Dockerfile), against this
# checkout: the server's, the client's and the end-to-end tests, including
# the iPhone (WebKit) project, which Playwright can't run on macOS 12.
#
#   docker/test.sh            every suite
#   docker/test.sh e2e        just one: server, client or e2e
#   docker/test.sh --gpu ...  with this machine's NVIDIA GPU (needs the
#                             NVIDIA Container Toolkit)
#
# The checkout is mounted read-write, but node_modules are kept in Docker
# volumes, since the ones on a Mac or Windows host won't run on Linux.
set -euo pipefail
cd "$(dirname "$0")/.."

gpu=()
if [ "${1:-}" = "--gpu" ]; then
  gpu=(--gpus all)
  shift
fi
suite=${1:-all}

docker build -f docker/ci.Dockerfile -t omnifilter-ci .

script='
set -e
npm ci
npm ci --prefix client
clinfo --list || true
vulkaninfo --summary 2> /dev/null | grep -E "deviceName|driverName" || true
case "$SUITE" in
  server|all) npx mocha --exit --timeout 120000 --file server/test/setup.js server/test ;;
esac
case "$SUITE" in
  client|all) node scripts/client.js test ;;
esac
case "$SUITE" in
  e2e|all) xvfb-run -a npx playwright test ;;
esac
'
docker run --rm ${gpu[@]+"${gpu[@]}"} --ipc=host \
  -e SUITE="$suite" -e CI=1 \
  -v "$PWD":/work -w /work \
  -v omnifilter-ci-node-modules:/work/node_modules \
  -v omnifilter-ci-client-node-modules:/work/client/node_modules \
  omnifilter-ci bash -c "$script"
