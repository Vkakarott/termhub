-- An optional line under a machine's name ("MacBook do escritório"), shown only inside the app.
-- Additive and nullable: the previous container neither selects nor writes it during the
-- blue/green switch.
ALTER TABLE "machines" ADD COLUMN "subtitle" TEXT;
