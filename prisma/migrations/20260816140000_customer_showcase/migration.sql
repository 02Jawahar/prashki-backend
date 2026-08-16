-- CreateEnum
CREATE TYPE "ShowcaseStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ShowcaseMediaType" AS ENUM ('VIDEO', 'IMAGE');

-- CreateTable
CREATE TABLE "showcase_items" (
    "id" TEXT NOT NULL,
    "mediaType" "ShowcaseMediaType" NOT NULL DEFAULT 'VIDEO',
    "mediaUrl" TEXT NOT NULL,
    "posterUrl" TEXT,
    "altText" TEXT NOT NULL,
    "caption" TEXT,
    "creditName" TEXT,
    "creditHandle" TEXT,
    "sourceUrl" TEXT,
    "consentGrantedAt" TIMESTAMP(3),
    "consentNote" TEXT,
    "status" "ShowcaseStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "showcase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "showcase_products" (
    "showcaseItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "showcase_products_pkey" PRIMARY KEY ("showcaseItemId","productId")
);

-- CreateIndex
CREATE INDEX "showcase_items_status_position_idx" ON "showcase_items"("status", "position");

-- CreateIndex
CREATE INDEX "showcase_products_productId_idx" ON "showcase_products"("productId");

-- AddForeignKey
ALTER TABLE "showcase_products" ADD CONSTRAINT "showcase_products_showcaseItemId_fkey" FOREIGN KEY ("showcaseItemId") REFERENCES "showcase_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "showcase_products" ADD CONSTRAINT "showcase_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
