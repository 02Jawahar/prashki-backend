-- AlterEnum
ALTER TYPE "ShipmentStatus" ADD VALUE 'EXCEPTION';

-- AlterTable
ALTER TABLE "shipment_events" ADD COLUMN     "ignoredForStatus" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerEventId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "dispatchedBy" TEXT,
ADD COLUMN     "heightMm" INTEGER,
ADD COLUMN     "labelUrl" TEXT,
ADD COLUMN     "lengthMm" INTEGER,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packedAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerShipmentId" TEXT,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "widthMm" INTEGER;

-- AlterTable
ALTER TABLE "shipping_methods" ADD COLUMN     "maxWeightGrams" INTEGER,
ADD COLUMN     "provider" TEXT;

-- AlterTable
ALTER TABLE "shipping_zones" ADD COLUMN     "isServiceable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "unserviceableMessage" TEXT;

-- CreateTable
CREATE TABLE "shipping_rates" (
    "id" TEXT NOT NULL,
    "methodId" TEXT NOT NULL,
    "label" TEXT,
    "minWeightGrams" INTEGER,
    "maxWeightGrams" INTEGER,
    "minSubtotal" INTEGER,
    "maxSubtotal" INTEGER,
    "amount" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipping_rates_methodId_position_idx" ON "shipping_rates"("methodId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_providerEventId_key" ON "shipment_events"("providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_providerShipmentId_key" ON "shipments"("providerShipmentId");

-- AddForeignKey
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "shipping_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
