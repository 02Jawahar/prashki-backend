-- A set group could hold one row per variant, which was right when a set meant
-- several different garments: each piece is its own product and its own size.
--
-- A product sold in parts is the other shape. The top, the pant and the cape
-- are one garment in one size, so every part in the group is the SAME variant
-- and the old index refused the second one. Buying a top and a pant together
-- failed on a uniqueness rule written for a different kind of set.
--
-- Widened to include the part. A group may now hold several parts of one
-- variant, and still cannot hold the same part twice.
--
-- COALESCE rather than the bare column: NULLs never compare equal in a unique
-- index, so a set of separate garments — where setOptionId is null — would
-- lose the protection the old index gave it.
DROP INDEX IF EXISTS "cart_items_setGroupId_variantId_key";

CREATE UNIQUE INDEX "cart_items_setGroupId_variantId_part_key"
    ON "cart_items"("setGroupId", "variantId", COALESCE("setOptionId", ''))
    WHERE "setGroupId" IS NOT NULL;
