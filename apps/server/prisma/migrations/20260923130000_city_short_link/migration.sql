-- The public city's short link: the one termhub created through TypeToAccess, and one the person
-- may paste to replace it. Additive and nullable: the previous container neither selects nor
-- writes these columns during the blue/green switch.
ALTER TABLE "users" ADD COLUMN "city_short_url_partner" TEXT;
ALTER TABLE "users" ADD COLUMN "city_short_url_custom" TEXT;
