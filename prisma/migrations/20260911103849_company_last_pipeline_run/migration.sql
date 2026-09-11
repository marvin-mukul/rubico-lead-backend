-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "lastPipelineRunAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Company_lastPipelineRunAt_idx" ON "Company"("lastPipelineRunAt");
