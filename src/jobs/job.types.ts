/**
 * FR-B8: every run writes `counts` — records fetched, deduped, filtered out,
 * enriched, classified, scored, briefed. These counts are the source for
 * metrics M1–M8, so the stage names are fixed here rather than invented per job.
 */
export interface JobCounts {
  fetched?: number;
  deduped?: number;
  filteredOut?: number;
  /** Rejected by the opportunity trigger gate — no evidence of a tech problem. */
  noTrigger?: number;
  suppressed?: number;
  enriched?: number;
  classified?: number;
  discarded?: number;
  scored?: number;
  briefed?: number;
  failed?: number;
}

export type CountKey = keyof JobCounts;

export interface JobContext {
  readonly jobRunId: string;
  /** Watermark supplied by the trigger; a source may override from its own state. */
  readonly since?: Date;
  /** When true, do everything except persist or spend. */
  readonly dryRun: boolean;
  readonly params: Record<string, unknown>;
  /**
   * Accumulate counts as work completes, not at the end. FR-B9 leaves
   * committed work intact on failure, so the counts must describe what
   * actually happened before the failure.
   */
  count(key: CountKey, delta?: number): void;
  readonly counts: JobCounts;
}

export interface JobHandler {
  /** Registry key, e.g. `ingest.sec-edgar` (§7.2). */
  readonly name: string;
  run(context: JobContext): Promise<void>;
}

export class MutableJobContext implements JobContext {
  readonly counts: JobCounts = {};

  constructor(
    readonly jobRunId: string,
    readonly params: Record<string, unknown>,
    readonly dryRun: boolean,
    readonly since?: Date,
  ) {}

  count(key: CountKey, delta = 1): void {
    this.counts[key] = (this.counts[key] ?? 0) + delta;
  }
}

/**
 * Counts as a plain JSON object for the `job_runs.counts` column.
 * Prisma's InputJsonValue needs an index signature, and undefined values must
 * not reach JSONB — a stage that never ran should be absent, not null.
 */
export function serializeCounts(counts: JobCounts): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  );
}
