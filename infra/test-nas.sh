#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker network inspect ijara360-test >/dev/null
docker start ijara360-test-postgres >/dev/null
docker build --target api -t ijara360-api:test .
# Read the dedicated test environment inside a disposable container; never production.env.
docker run --rm --network ijara360-test -v /volume1/docker/ijara360/test/api.env:/run/api.env:ro ijara360-api:test node --env-file=/run/api.env node_modules/prisma/build/index.js migrate deploy
docker run --rm --network ijara360-test -v /volume1/docker/ijara360/test/api.env:/run/api.env:ro ijara360-api:test node --env-file=/run/api.env --test --test-concurrency=1 apps/api/test/foundation.test.cjs apps/api/test/origins.test.cjs apps/api/test/residents.test.cjs
