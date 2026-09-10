-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "canonicalDomain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "region" TEXT,
    "headcountBand" TEXT,
    "industry" TEXT,
    "detectedStack" JSONB,
    "legacyFlags" JSONB,
    "atsProvider" TEXT,
    "atsSlug" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEnrichedAt" TIMESTAMP(3),
    "suppressionReason" TEXT,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceUrl" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "excerpt" TEXT,
    "raw" JSONB NOT NULL,
    "confirmedByLlm" BOOLEAN NOT NULL DEFAULT false,
    "dedupeHash" TEXT NOT NULL,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fitScore" INTEGER NOT NULL,
    "intentScore" DOUBLE PRECISION NOT NULL,
    "compoundBonus" INTEGER NOT NULL DEFAULT 0,
    "totalScore" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "llmClassification" JSONB,
    "likelyNeed" TEXT,
    "rubicoService" TEXT,
    "brief" JSONB,
    "confidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "scoredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "seniority" TEXT,
    "email" TEXT,
    "emailStatus" TEXT,
    "source" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creditCost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "user" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "notes" TEXT,
    "scoreAtDecision" INTEGER NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiUsage" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "units" DOUBLE PRECISION NOT NULL,
    "usdCost" DOUBLE PRECISION NOT NULL,
    "leadId" TEXT,

    CONSTRAINT "ApiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoringConfig" (
    "key" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "ScoringConfig_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "params" JSONB,
    "counts" JSONB,
    "error" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_canonicalDomain_key" ON "Company"("canonicalDomain");

-- CreateIndex
CREATE INDEX "Company_suppressionReason_idx" ON "Company"("suppressionReason");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_dedupeHash_key" ON "Signal"("dedupeHash");

-- CreateIndex
CREATE INDEX "Signal_companyId_type_eventDate_idx" ON "Signal"("companyId", "type", "eventDate");

-- CreateIndex
CREATE INDEX "Lead_band_status_totalScore_idx" ON "Lead"("band", "status", "totalScore");

-- CreateIndex
CREATE INDEX "ApiUsage_date_provider_idx" ON "ApiUsage"("date", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JobRun_jobName_createdAt_idx" ON "JobRun"("jobName", "createdAt");

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
