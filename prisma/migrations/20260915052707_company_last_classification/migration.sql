-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "lastClassification" JSONB,
ADD COLUMN     "lastClassifiedAt" TIMESTAMP(3),
ADD COLUMN     "lastClassifyKeep" BOOLEAN;
