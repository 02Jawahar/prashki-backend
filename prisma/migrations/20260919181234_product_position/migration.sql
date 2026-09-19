-- AlterTable
ALTER TABLE "products" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "products_categoryId_position_idx" ON "products"("categoryId", "position");
