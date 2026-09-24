#!/bin/sh
set -eu
cd /volume1/docker/ijara360/test/source
docker network inspect ijara360-test >/dev/null 2>&1 || docker network create ijara360-test
docker network connect ijara360-test ijara360-test-postgres 2>/dev/null || true
docker build --target api -t ijara360-api:test .
docker run --rm --network ijara360-test --env-file /volume1/docker/ijara360/test/api.env ijara360-api:test node node_modules/prisma/build/index.js migrate deploy
docker run --rm --network ijara360-test --env-file /volume1/docker/ijara360/test/api.env ijara360-api:test node --test --test-concurrency=1 apps/api/test/foundation.test.cjs
