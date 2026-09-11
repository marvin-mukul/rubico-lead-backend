import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/index.js';
import { ScoringService } from '../scoring/index.js';
import type { DecisionBody, LeadListQuery } from './dto.js';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: ScoringService,
  ) {}

  async list(query: LeadListQuery) {
    const where = {
      ...(query.band ? { band: query.band } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.minScore === undefined ? {} : { totalScore: { gte: query.minScore } }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: [{ totalScore: 'desc' }, { scoredAt: 'desc' }],
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
        },
      }),
      this.prisma.lead.update({ where: { id: leadId }, data: { status: body.decision } }),
    ]);

    return {
      leadId,
      status: body.decision,
      scoreAtDecision: decision.scoreAtDecision,
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
