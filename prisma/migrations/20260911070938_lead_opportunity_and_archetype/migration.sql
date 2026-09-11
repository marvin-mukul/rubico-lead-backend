-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "rubicoService",
ADD COLUMN     "archetype" TEXT,
ADD COLUMN     "opportunityKey" TEXT NOT NULL DEFAULT 'general',
ADD COLUMN     "rubicoCapabilities" JSONB,
ADD COLUMN     "whyThisLead" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Lead_companyId_opportunityKey_key" ON "Lead"("companyId", "opportunityKey");

