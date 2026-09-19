-- What can be bought of one product, and for how much (M03).
--
-- The lighter way to sell a set: the pieces are choices on this product rather
-- than products of their own. One size governs whatever is chosen, and the
-- pieces have no page — the trade for not maintaining four products to sell
-- one look.

CREATE TABLE "product_set_options" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_set_options_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_set_options_productId_label_key"
    ON "product_set_options"("productId", "label");
CREATE INDEX "product_set_options_productId_idx" ON "product_set_options"("productId");

ALTER TABLE "product_set_options"
    ADD CONSTRAINT "product_set_options_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nothing is sold for nothing by accident.
ALTER TABLE "product_set_options"
    ADD CONSTRAINT "product_set_options_price_positive" CHECK ("price" > 0);

-- Which part of the product a bag line is for.
ALTER TABLE "cart_items" ADD COLUMN "setOptionId" TEXT;

ALTER TABLE "cart_items"
    ADD CONSTRAINT "cart_items_setOptionId_fkey"
    FOREIGN KEY ("setOptionId") REFERENCES "product_set_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The same size in two different parts of a set is two lines, not one with a
-- doubled quantity. Only a plain line — no option, no set group — merges.
DROP INDEX IF EXISTS "cart_items_cartId_variantId_standalone_key";

CREATE UNIQUE INDEX "cart_items_cartId_variantId_plain_key"
    ON "cart_items"("cartId", "variantId")
    WHERE "setGroupId" IS NULL AND "setOptionId" IS NULL;

CREATE UNIQUE INDEX "cart_items_cartId_variantId_option_key"
    ON "cart_items"("cartId", "variantId", "setOptionId")
    WHERE "setOptionId" IS NOT NULL;
