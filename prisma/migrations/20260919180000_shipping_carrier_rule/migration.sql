-- How the carrier is chosen when the provider quotes live rates.
--
-- Null keeps the method's flat rate — priced here, booked by hand. Set to
-- 'cheapest' or 'fastest', the price at checkout is what the carrier quotes
-- for that parcel, and the same rule picks the courier at booking.
--
-- The flat rate is kept either way: it is what the customer is charged when
-- the carrier cannot be reached. A checkout that fails because an aggregator
-- is down is worse than one that occasionally under-charges.

ALTER TABLE "shipping_methods" ADD COLUMN "carrierRule" TEXT;

ALTER TABLE "shipping_methods"
    ADD CONSTRAINT "shipping_methods_carrier_rule_known"
    CHECK ("carrierRule" IS NULL OR "carrierRule" IN ('cheapest', 'fastest'));
