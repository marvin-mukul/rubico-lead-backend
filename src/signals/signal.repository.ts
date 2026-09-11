import { Injectable, Logger } from '@nestjs/common';
import type { SignalType } from '../common/domain/index.js';
import { PrismaService } from '../common/prisma/index.js';
import type { Prisma } from '../generated/prisma/client.js';
import { EvidenceService } from '../opportunity/evidence.service.js';
import { dedupeHash } from './dedupe-hash.js';

export interface SignalInsert {
  companyId: string;
  type: SignalType;
  eventDate: Date;
  sourceUrl: string;
  sourceName: string;
  subject: string;
  excerpt?: string;
  raw: Prisma.InputJsonValue;
}

export interface InsertOutcome {
  signalId: string;
  /** False when this exact event was already recorded (A2). */
  created: boolean;
}

export interface BatchOutcome {
  created: number;
  /** Rows rejected by the unique dedupeHash — the `deduped` count (FR-B8). */
  deduped: number;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class SignalRepository {
  private readonly logger = new Logger(SignalRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evidence: EvidenceService,
  ) {}

  /**
   * FR-B9: ingestion is per-record transactional, not per-batch. A single
   * insert is one statement, so a failure partway through a batch leaves every
   * earlier signal committed.
   */
  async insert(input: SignalInsert): Promise<InsertOutcome> {
    const hash = dedupeHash({
      companyId: input.companyId,
      type: input.type,
      eventDate: input.eventDate,
      subject: input.subject,
    });

    try {
      const signal = await this.prisma.signal.create({
        data: {
          companyId: input.companyId,
          type: input.type,
          eventDate: input.eventDate,
          sourceUrl: input.sourceUrl,
          sourceName: input.sourceName,
          ...(input.excerpt === undefined ? {} : { excerpt: input.excerpt }),
          raw: input.raw,
          dedupeHash: hash,
          // Resolved once, when the evidence is observed. Recomputing later
          // against edited patterns would silently rewrite history.
          evidenceStrength: this.evidence.strengthOf({
            type: input.type,
            excerpt: input.excerpt ?? null,
            subject: input.subject,
          }),
        },
        select: { id: true },
      });
      return { signalId: signal.id, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.signal.findUniqueOrThrow({
        where: { dedupeHash: hash },
        select: { id: true },
      });
      return { signalId: existing.id, created: false };
    }
  }

  /** Per-record, deliberately — see `insert`. Not `createMany`. */
  async insertMany(inputs: SignalInsert[]): Promise<BatchOutcome> {
    let created = 0;
    let deduped = 0;
    for (const input of inputs) {
      const outcome = await this.insert(input);
      if (outcome.created) created++;
      else deduped++;
    }
    if (deduped) this.logger.debug(`Deduped ${deduped} of ${inputs.length} signals`);
    return { created, deduped };
  }

  /** Signals for a company, newest event first. */
  forCompany(companyId: string, since?: Date) {
    return this.prisma.signal.findMany({
      where: { companyId, ...(since ? { eventDate: { gte: since } } : {}) },
      orderBy: { eventDate: 'desc' },
    });
  }
}
