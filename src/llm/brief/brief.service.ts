import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../common/config/app-config.service.js';
import { MeteredClient } from '../../common/metering/index.js';
import { PrismaService } from '../../common/prisma/index.js';
import { OpportunityConfigService } from '../../opportunity/index.js';
import { buildClassifyPrompt, type ClassifiableCompany, type ClassifiableSignal } from '../classify/classify.service.js';
import { LLM_BRIEF_PROVIDER, type LlmProvider } from '../llm-provider.interface.js';
import { buildBriefSystemPrompt } from '../prompts.js';
import { briefSchema, type Brief } from '../schemas.js';
import { validateBrief, type BriefDefect } from './brief-validation.js';

export interface BriefRequest {
  leadId: string;
  company: ClassifiableCompany;
  signals: ClassifiableSignal[];
  likelyNeed?: string | null;
}

export interface BriefOutcome {
  leadId: string;
  brief?: Brief;
  /** Populated when the brief was rejected; it is never shown to a human. */
  defects?: BriefDefect[];
  error?: string;
}

@Injectable()
export class BriefService {
  private readonly logger = new Logger(BriefService.name);
  /** Built once from static config (P22) — see ClassifyService for why this still caches. */
  private readonly systemPrompt: string;

  constructor(
    @Inject(LLM_BRIEF_PROVIDER) private readonly provider: LlmProvider,
    private readonly metered: MeteredClient,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    opportunityConfig: OpportunityConfigService,
  ) {
    this.systemPrompt = buildBriefSystemPrompt(opportunityConfig);
  }

  /**
   * FR-AI3: one batch submission for the whole run when LLM_BRIEF_BATCH is
   * on. Nothing here is latency-sensitive, so the 50% discount is free money.
   */
  async generate(requests: BriefRequest[]): Promise<BriefOutcome[]> {
    if (requests.length === 0) return [];

    const { provider, model, batch } = this.config.brief;
    const byLead = new Map(requests.map((request) => [request.leadId, request]));

    const args = requests.map((request) => ({
      key: request.leadId,
      system: this.systemPrompt,
      user: buildBriefPrompt(request),
      schema: briefSchema,
      model,
      batch,
      cacheSystem: true,
      maxTokens: 3_000,
    }));

    // The whole submission goes through MeteredClient as one metered call.
    // Per-lead attribution still lands in api_usage for the classify step;
    // a batch is one upstream request and is billed as one.
    const results = await this.metered.call({
      provider,
      operation: batch ? 'brief.batch' : 'brief',
      estimatedCost: 0.002 * requests.length,
      // The provider honours the per-request `batch` flag, so this is one
      // call path whether or not batching is on.
      execute: () => this.provider.completeMany(args),
      computeCost: (completions) =>
        completions.reduce(
          (total, entry) =>
            entry.completion
              ? total + this.config.prices.compute(provider, model, entry.completion.usage)
              : total,
          0,
        ),
      units: (completions) => completions.length,
    });

    const outcomes: BriefOutcome[] = [];
    for (const entry of results) {
      const request = byLead.get(entry.key);
      if (!request) continue;

      if (!entry.completion) {
        outcomes.push({ leadId: entry.key, error: entry.error ?? 'no completion' });
        continue;
      }
      outcomes.push(await this.acceptOrReject(request, entry.completion.result));
    }
    return outcomes;
  }

  /**
   * FR-AI6, enforced in code: a claim citing an id that is not a real signal
   * for this company is a defect, and the whole brief is rejected rather
   * than shown with the bad claim removed. A brief that has been quietly
   * edited is no longer the thing that was validated.
   */
  private async acceptOrReject(request: BriefRequest, brief: Brief): Promise<BriefOutcome> {
    const knownIds = new Set(request.signals.map((signal) => signal.id));
    const validation = validateBrief(brief, knownIds);

    if (!validation.valid) {
      this.logger.error(
        `Brief rejected for lead ${request.leadId}: ` +
          validation.defects.map((defect) => `${defect.kind} — ${defect.detail}`).join('; '),
      );
      return { leadId: request.leadId, defects: validation.defects };
    }

    await this.prisma.lead.update({
      where: { id: request.leadId },
      data: { brief: brief as never, confidence: brief.confidence },
    });
    return { leadId: request.leadId, brief };
  }

}

export function buildBriefPrompt(request: BriefRequest): string {
  const base = buildClassifyPrompt(request.company, request.signals);
  return [
    base,
    '',
    request.likelyNeed ? `## LIKELY NEED (from classification)\n${request.likelyNeed}` : '',
    '',
    'Write the brief. Every claim must carry the signal_id it comes from,',
    'and the opening line must reference only cited evidence.',
  ]
    .filter(Boolean)
    .join('\n');
}
