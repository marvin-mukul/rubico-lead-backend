import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import { MeteredClient } from '../../common/metering/index.js';
import { PrismaService } from '../../common/prisma/index.js';
import { OpportunityConfigService } from '../../opportunity/index.js';
import { LLM_CLASSIFY_PROVIDER, type LlmProvider } from '../llm-provider.interface.js';
import { buildClassifySystemPrompt } from '../prompts.js';
import { classificationSchema, type Classification } from '../schemas.js';
import { validateClassification } from './classify-validation.js';

export interface ClassifiableCompany {
  id: string;
  canonicalDomain: string;
  name: string;
  country?: string | null;
  industry?: string | null;
  headcountBand?: string | null;
  detectedStack?: unknown;
  legacyFlags?: unknown;
}

export interface ClassifiableSignal {
  id: string;
  type: string;
  eventDate: Date;
  sourceName: string;
  sourceUrl: string;
  excerpt?: string | null;
}

export interface ClassificationOutcome {
  classification: Classification;
  /** FR-AI5: false means discard before scoring. */
  keep: boolean;
  discardReason?: string;
}

@Injectable()
export class ClassifyService {
  private readonly logger = new Logger(ClassifyService.name);
  /** Built once from static config (P22) — byte-identical across calls, so it still caches (FR-AI4). */
  private readonly systemPrompt: string;

  constructor(
    @Inject(LLM_CLASSIFY_PROVIDER) private readonly provider: LlmProvider,
    private readonly metered: MeteredClient,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    opportunityConfig: OpportunityConfigService,
  ) {
    this.systemPrompt = buildClassifySystemPrompt(opportunityConfig);
  }

  async classify(
    company: ClassifiableCompany,
    signals: ClassifiableSignal[],
    leadId?: string,
  ): Promise<ClassificationOutcome> {
    const { provider, model } = this.config.classify;

    const { result, usage } = await this.metered.call({
      provider,
      operation: 'classify',
      ...(leadId ? { leadId } : {}),
      estimatedCost: 0.0002,
      execute: () =>
        this.provider.complete({
          system: this.systemPrompt,
          user: buildClassifyPrompt(company, signals),
          schema: classificationSchema,
          model,
          cacheSystem: true,
          maxTokens: 1_500,
        }),
      computeCost: (completion) =>
        this.config.prices.compute(provider, model, completion.usage),
      units: (completion) => completion.usage.inputTokens + completion.usage.outputTokens,
    });

    void usage;
    return this.evaluate(
      result,
      new Set(signals.map((signal) => signal.id)),
    );
  }

  /**
   * FR-AI5: either refusal discards the record before scoring. FR-AI6
   * (extended, P22): a why-this-lead step or a top-level citation naming a
   * signal that does not exist for this company is a defect, discarded the
   * same way — not repaired, not surfaced. Split out from the call so both
   * rules are testable without touching a provider.
   */
  evaluate(classification: Classification, knownSignalIds: Set<string>): ClassificationOutcome {
    if (!classification.has_rubico_opportunity) {
      return {
        classification,
        keep: false,
        discardReason: 'no_rubico_opportunity',
      };
    }
    if (!classification.evidence_sufficient) {
      return {
        classification,
        keep: false,
        discardReason: 'insufficient_evidence',
      };
    }

    const validation = validateClassification(classification, knownSignalIds);
    if (!validation.valid) {
      this.logger.error(
        `Classification discarded — invalid citation: ` +
          validation.defects.map((defect) => defect.detail).join('; '),
      );
      return { classification, keep: false, discardReason: 'invalid_citation' };
    }

    return { classification, keep: true };
  }

  /** Persists the classifier's verdict onto the lead. */
  async saveToLead(leadId: string, outcome: ClassificationOutcome): Promise<void> {
    const { classification } = outcome;
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        llmClassification: classification as never,
        likelyNeed: classification.likely_need,
        archetype: classification.archetype === 'none' ? null : classification.archetype,
        rubicoCapabilities: classification.rubico_capabilities as never,
        whyThisLead: classification.why_this_lead as never,
        confidence: classification.confidence,
      },
    });
  }
}

/**
 * The volatile half of the prompt. Everything here changes per company, so it
 * sits after the cached prefix — putting any of it in the system prompt would
 * silently destroy the cache hit rate (FR-AI4).
 */
export function buildClassifyPrompt(
  company: ClassifiableCompany,
  signals: ClassifiableSignal[],
): string {
  const facts = [
    `domain: ${company.canonicalDomain}`,
    `name: ${company.name}`,
    company.country ? `country: ${company.country}` : null,
    company.industry ? `industry: ${company.industry}` : null,
    company.headcountBand ? `headcount band: ${company.headcountBand}` : null,
    describeJson('detected stack', company.detectedStack),
    describeJson('legacy flags', company.legacyFlags),
  ].filter(Boolean);

  const signalBlock = signals.length
    ? signals
        .map(
          (signal) =>
            `- id: ${signal.id}\n` +
            `  type: ${signal.type}\n` +
            `  date: ${signal.eventDate.toISOString().slice(0, 10)}\n` +
            `  source: ${signal.sourceName} (${signal.sourceUrl})\n` +
            `  excerpt: ${signal.excerpt ?? '(none)'}`,
        )
        .join('\n')
    : '(no signals)';

  return [
    '## COMPANY',
    facts.join('\n'),
    '',
    '## SIGNALS',
    signalBlock,
    '',
    'Decide whether Rubico has a genuine, evidenced opportunity here.',
    'Cite only the signal ids listed above.',
  ].join('\n');
}

function describeJson(label: string, value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => !k.endsWith('At'));
  return keys.length ? `${label}: ${keys.join(', ')}` : null;
}
