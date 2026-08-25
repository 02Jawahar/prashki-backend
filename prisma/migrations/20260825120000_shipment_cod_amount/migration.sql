-- Paise the courier collects on delivery, per parcel.
--
-- Additive with a default, so it is safe to apply while the previous release is
-- still serving: existing rows become 0, which is exactly right — every parcel
-- booked before this column existed was booked without a COD instruction.
-- AlterTable
ALTER TABLE "shipments" ADD COLUMN "codAmount" INTEGER NOT NULL DEFAULT 0;
