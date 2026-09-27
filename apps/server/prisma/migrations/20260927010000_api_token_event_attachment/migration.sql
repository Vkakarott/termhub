-- Which attachment a read_attachment call read (TER-200). Additive: the previous release never names it.
ALTER TABLE "api_token_events" ADD COLUMN "attachment_id" TEXT;
