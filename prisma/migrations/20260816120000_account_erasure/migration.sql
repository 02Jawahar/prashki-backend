-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'ANONYMISED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "anonymisedAt" TIMESTAMP(3);
