-- Sets: a product assembled from other products (M03).
--
-- Buying a set puts one line in the bag per piece rather than one line for the
-- set, so stock is taken from the real garments and a customer can have a
-- different size on the top than on the bottom.

CREATE TABLE "product_components" (
    "id" TEXT NOT NULL,
    "setProductId" TEXT NOT NULL,
    "componentProductId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "product_components_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_components_setProductId_componentProductId_key"
    ON "product_components"("setProductId", "componentProductId");
CREATE INDEX "product_components_componentProductId_idx"
    ON "product_components"("componentProductId");

ALTER TABLE "product_components"
    ADD CONSTRAINT "product_components_setProductId_fkey"
    FOREIGN KEY ("setProductId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_components"
    ADD CONSTRAINT "product_components_componentProductId_fkey"
    FOREIGN KEY ("componentProductId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A set cannot contain itself. Deeper cycles are refused in the service; this
-- catches the obvious one at the database.
ALTER TABLE "product_components"
    ADD CONSTRAINT "product_components_not_self"
    CHECK ("setProductId" <> "componentProductId");

-- Bag lines that came from a set.
ALTER TABLE "cart_items" ADD COLUMN "setGroupId" TEXT;
ALTER TABLE "cart_items" ADD COLUMN "setProductId" TEXT;
ALTER TABLE "cart_items" ADD COLUMN "setUnitPrice" INTEGER;

ALTER TABLE "cart_items"
    ADD CONSTRAINT "cart_items_setProductId_fkey"
    FOREIGN KEY ("setProductId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "cart_items_setGroupId_idx" ON "cart_items"("setGroupId");

-- Uniqueness now applies only to pieces bought on their own: adding the same
-- size twice still bumps the quantity. Set lines are deliberately separate
-- rows, because the same blouse can sit in the bag alone and inside a set at
-- two different prices.
ALTER TABLE "cart_items" DROP CONSTRAINT IF EXISTS "cart_items_cartId_variantId_key";
DROP INDEX IF EXISTS "cart_items_cartId_variantId_key";

CREATE UNIQUE INDEX "cart_items_cartId_variantId_standalone_key"
    ON "cart_items"("cartId", "variantId") WHERE "setGroupId" IS NULL;

-- One row per variant within one set group.
CREATE UNIQUE INDEX "cart_items_setGroupId_variantId_key"
    ON "cart_items"("setGroupId", "variantId") WHERE "setGroupId" IS NOT NULL;

-- Orders keep the grouping, snapshotted like every other fact on the line, so
-- history still reads as a set long after the set itself is withdrawn.
ALTER TABLE "order_items" ADD COLUMN "setGroupId" TEXT;
ALTER TABLE "order_items" ADD COLUMN "setNameSnapshot" TEXT;

CREATE INDEX "order_items_setGroupId_idx" ON "order_items"("setGroupId");
