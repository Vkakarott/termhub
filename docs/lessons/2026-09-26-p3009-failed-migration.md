---
symptom: "P3009: migrate found failed migrations in the target database"
tags: [prisma, deploy]
evidence: fixed
card: TER-57
agent: claude
date: 2026-09-26
---
## Cause

A Prisma migration failed half-way in production. On the next deploy, `prisma migrate deploy` refuses
to run at all while a migration is marked failed in the `_prisma_migrations` table — every later deploy
fails the same way, because the new color's container never finishes `prisma migrate deploy` and so
never becomes healthy (blue/green then has nothing healthy to switch the proxy to).

## Fix

Mark the failed migration as rolled back, then redeploy:

```bash
prisma migrate resolve --rolled-back <migration name>
```

Run it against production (same `DATABASE_URL` the app uses), then push again (or re-run the deploy):
the new container's `prisma migrate deploy` now proceeds past the failed row and applies the rest
normally.

## How to check

`docker ps --filter name=termhub-app` shows the active color (blue or green) as healthy, and the vhost
switch completes without the deploy script timing out waiting for a health check.
