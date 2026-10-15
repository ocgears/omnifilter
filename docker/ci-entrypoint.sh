#!/usr/bin/env bash
# Starts MongoDB in the background (the tests' default address), then runs
# the command given to the container.
set -euo pipefail
mkdir -p /tmp/mongo
mongod --dbpath /tmp/mongo --bind_ip 127.0.0.1 --fork --logpath /tmp/mongod.log > /dev/null
exec "$@"
