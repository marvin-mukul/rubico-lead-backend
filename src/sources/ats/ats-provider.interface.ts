/** One job posting, normalised across the three ATS vendors. */
export interface AtsPosting {
  id: string;
  title: string;
  url: string;
  /** When the posting was created or last updated upstream. */
  postedAt: Date;
  location?: string;
  department?: string;
}

/**
 * A board provider. Each vendor has its own JSON shape; nothing above this
 * interface should know which one a company uses.
 */
export interface AtsProvider {
  readonly name: 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'smartrecruiters' | 'recruitee';
  /** Null when the board does not exist (a stale slug), rather than throwing. */
  listPostings(slug: string): Promise<AtsPosting[] | null>;
}

export const ATS_PROVIDER = Symbol('ATS_PROVIDER');
