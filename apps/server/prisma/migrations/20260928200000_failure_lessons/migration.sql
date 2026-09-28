-- Failure lessons (spec 2026-09-27 failure lessons §3). Additive only.
ALTER TABLE "memory_items" ADD COLUMN "verified_at" TIMESTAMP(3);
ALTER TABLE "memory_items" ADD COLUMN "verified_by" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "verified_hash" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "hidden_hash" TEXT;
ALTER TABLE "memory_items" ADD COLUMN "meta" JSONB;
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
