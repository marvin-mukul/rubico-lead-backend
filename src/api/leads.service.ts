import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import { ScoringService } from '../scoring/index.js';
import type { DecisionBody, LeadListQuery } from './dto.js';

/** Midnight after `date` (YYYY-MM-DD), so a `to` bound includes its own day. */
function nextDay(date: string): Date {
  const midnight = new Date(`${date}T00:00:00.000Z`);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  return midnight;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: ScoringService,
  ) {}

  async list(query: LeadListQuery) {
    /**
     * The date range and signal-type filters both constrain the company's
     * SIGNALS, not the lead row.
     *
     * `scoredAt` would be the easy field to filter on and the wrong one:
     * every lead is rescored nightly, so a "last 14 days" filter over it
     * returns everything or nothing depending on when the job last ran. The
     * question a reviewer is actually asking — what happened recently — is
     * answered by the event dates of the evidence.
     *
     * One `some` clause holding both, deliberately. Two separate `some`
     * clauses would match a company with an old S2 and an unrelated recent
     * S6, which is not what "an S2 in the last fortnight" means.
     */
    const signalWindow = {
      ...(query.signalType ? { type: query.signalType } : {}),
      ...(query.from ?? query.to ?
        {
          eventDate: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            // Inclusive of the whole `to` day: a bare date parses as
            // midnight, so `lte` on it would exclude everything that
            // happened during the day the reviewer asked for.
            ...(query.to ? { lt: nextDay(query.to) } : {}),
          },
        }
      : {}),
    };

    const where = {
      ...(query.band ? { band: query.band } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.minScore === undefined ? {} : { totalScore: { gte: query.minScore } }),
      ...(Object.keys(signalWindow).length > 0 ?
        { company: { signals: { some: signalWindow } } }
      : {}),
    };

    // `recency` orders by when the lead was last scored, which for a nightly
    // rescore is "most recently changed". Score stays the tiebreak either
    // way, so two leads from the same run read in a stable order.
    const orderBy =
      query.sort === 'recency' ?
        ([{ scoredAt: 'desc' }, { totalScore: 'desc' }] as const)
      : ([{ totalScore: 'desc' }, { scoredAt: 'desc' }] as const);

    const [total, rows] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: [...orderBy],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { company: { select: { canonicalDomain: true, name: true } } },
      }),
    ]);

    return {
      page: query.page,
      pageSize: query.pageSize,
      total,
      leads: rows.map((lead) => ({
        id: lead.id,
        companyId: lead.companyId,
        canonicalDomain: lead.company.canonicalDomain,
        companyName: lead.company.name,
        fitScore: lead.fitScore,
        intentScore: lead.intentScore,
        compoundBonus: lead.compoundBonus,
        totalScore: lead.totalScore,
        band: lead.band,
        status: lead.status,
        likelyNeed: lead.likelyNeed,
        archetype: lead.archetype,
        opportunityKey: lead.opportunityKey,
        confidence: lead.confidence,
        scoredAt: lead.scoredAt.toISOString(),
        // Funnel M7: brief content is heavy and already fetched by GET
        // /api/leads/:id — the list row only needs to say whether one exists.
        hasBrief: lead.brief !== null,
      })),
    };
  }

  /**
   * FR-B16: returns per-signal contributions with decay already applied, and
   * the evidence behind them with source URLs (A3). The frontend renders;
   * scoring arithmetic stays in one place.
   */
  async detail(id: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        company: true,
        decisions: { orderBy: { decidedAt: 'desc' } },
      },
    });
    if (!lead) throw new NotFoundException(`Lead ${id} not found`);

    const scored = await this.scoring.contributionsForLead(id);
    const signals = await this.prisma.signal.findMany({
      where: { companyId: lead.companyId },
      orderBy: { eventDate: 'desc' },
    });

    return {
      id: lead.id,
      companyId: lead.companyId,
      canonicalDomain: lead.company.canonicalDomain,
      companyName: lead.company.name,
      fitScore: lead.fitScore,
      intentScore: lead.intentScore,
      compoundBonus: lead.compoundBonus,
      totalScore: lead.totalScore,
      band: lead.band,
      status: lead.status,
      likelyNeed: lead.likelyNeed,
      archetype: lead.archetype,
      opportunityKey: lead.opportunityKey,
      confidence: lead.confidence,
      scoredAt: lead.scoredAt.toISOString(),
      hasBrief: lead.brief !== null,
      brief: lead.brief ?? null,
      llmClassification: lead.llmClassification ?? null,
      rubicoCapabilities: (lead.rubicoCapabilities as string[] | null) ?? null,
      whyThisLead: lead.whyThisLead ?? null,
      ...(scored?.bandReason ? { bandReason: scored.bandReason } : {}),
      contributions: (scored?.contributions ?? []).map((contribution) => ({
        ...contribution,
        eventDate: contribution.eventDate.toISOString(),
      })),
      evidence: signals.map((signal) => ({
        signalId: signal.id,
        type: signal.type,
        eventDate: signal.eventDate.toISOString(),
        sourceName: signal.sourceName,
        sourceUrl: signal.sourceUrl,
        excerpt: signal.excerpt,
      })),
      company: {
        id: lead.company.id,
        canonicalDomain: lead.company.canonicalDomain,
        name: lead.company.name,
        country: lead.company.country,
        region: lead.company.region,
        headcountBand: lead.company.headcountBand,
        industry: lead.company.industry,
        detectedStack: lead.company.detectedStack ?? null,
        legacyFlags: lead.company.legacyFlags ?? null,
        suppressionReason: lead.company.suppressionReason,
      },
      decisions: lead.decisions.map((decision) => ({
        id: decision.id,
        user: decision.user,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        attribution: decision.attribution,
        notes: decision.notes,
        scoreAtDecision: decision.scoreAtDecision,
        decidedAt: decision.decidedAt.toISOString(),
      })),
    };
  }

  /**
   * FR-B3: `scoreAtDecision` is captured here, at decision time, from the
   * lead's current score — never read back from `Lead.totalScore` later. The
   * score changes nightly, and calibration (M6) needs the number the human
   * actually saw.
   */
  async decide(leadId: string, user: string, body: DecisionBody) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, totalScore: true },
    });
    if (!lead) throw new NotFoundException(`Lead ${leadId} not found`);

    const [decision] = await this.prisma.$transaction([
      this.prisma.decision.create({
        data: {
          leadId,
          user,
          decision: body.decision,
          reasonCode: body.reasonCode,
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          scoreAtDecision: lead.totalScore,
          attribution: body.attribution,
        },
      }),
      this.prisma.lead.update({ where: { id: leadId }, data: { status: body.decision } }),
    ]);

    return {
      leadId,
      status: body.decision,
      scoreAtDecision: decision.scoreAtDecision,
      attribution: decision.attribution,
      decidedAt: decision.decidedAt.toISOString(),
    };
  }

  async company(id: string) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: { signals: { orderBy: { eventDate: 'desc' } } },
    });
    if (!company) throw new NotFoundException(`Company ${id} not found`);

    return {
      id: company.id,
      canonicalDomain: company.canonicalDomain,
      name: company.name,
      country: company.country,
      region: company.region,
      headcountBand: company.headcountBand,
      industry: company.industry,
      detectedStack: company.detectedStack ?? null,
      legacyFlags: company.legacyFlags ?? null,
      atsProvider: company.atsProvider,
      atsSlug: company.atsSlug,
      suppressionReason: company.suppressionReason,
      firstSeenAt: company.firstSeenAt.toISOString(),
      lastEnrichedAt: company.lastEnrichedAt?.toISOString() ?? null,
      signals: company.signals.map((signal) => ({
        signalId: signal.id,
        type: signal.type,
        eventDate: signal.eventDate.toISOString(),
        sourceName: signal.sourceName,
        sourceUrl: signal.sourceUrl,
        excerpt: signal.excerpt,
      })),
    };
  }
}
