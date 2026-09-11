-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "attribution" TEXT NOT NULL DEFAULT 'builder';

-- CreateIndex
CREATE INDEX "Decision_attribution_decidedAt_idx" ON "Decision"("attribution", "decidedAt");
