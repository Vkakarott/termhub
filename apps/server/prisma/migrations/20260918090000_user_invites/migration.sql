-- Invites: who was invited and whether they already signed in (both nullable, backward compatible).
ALTER TABLE "users" ADD COLUMN "invited_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);
