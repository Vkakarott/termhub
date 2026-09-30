---
symptom: "docker run pgvector/pgvector:pg16 stays at \"Unable to find image 'pgvector/pgvector:pg16' locally\" and never finishes"
tags: [docker, postgres, pgvector, tests, local-dev]
evidence: fixed
card: TER-541
pr: https://github.com/engenhariainversa/termhub/pull/256
agent: claude
date: 2026-09-30
---
## Cause

The repository tests (`TERMHUB_DB_TESTS=1`) need a migrated Postgres with the `vector` extension; CI
uses `pgvector/pgvector:pg16`. On the maintainer's Mac the pull of that image from Docker Hub hung
with no progress for over 30 minutes (twice), while `apt` mirrors were reachable. Plain `postgres:16`
was already local, but the `chat_decisions` migration fails on it without `vector`.

## Fix

Start the throwaway database from the local `postgres:16` image and install pgvector from Debian's
apt inside it, then migrate:

```bash
docker run -d --name th-test-db -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=termhub -p 127.0.0.1:55432:5432 postgres:16
docker exec th-test-db sh -c 'apt-get update -qq && apt-get install -y -qq postgresql-16-pgvector'
cd apps/server && DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/termhub npx prisma migrate deploy
```

The name follows CLAUDE.md (`th-*`, never a production container name). Remove it with
`docker rm -f th-test-db` when done.

## How to check

`npx prisma migrate deploy` ends with "All migrations have been successfully applied", and
`TERMHUB_DB_TESTS=1 DATABASE_URL=… npx vitest run src/db/repositories/project-groups.db.test.ts`
runs the tests instead of skipping them.
