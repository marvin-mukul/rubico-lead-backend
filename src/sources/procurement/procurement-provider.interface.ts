/** One public-sector notice, normalised across the three feeds. */
export interface ProcurementNotice {
  /** Provider-unique id, used for traceability rather than dedupe. */
  id: string;
  buyerName: string;
  /**
   * Contact email from the notice. This is where the company domain comes
   * from — and the reason procurement works where `sec-edgar` does not.
   * SEC publishes no filer website, so signals could never attach to a
   * company; every procurement feed carries a contact address, giving exact
   * attribution with no name→domain guessing.
   */
  buyerEmail?: string;
  title: string;
  description?: string;
  /** Native taxonomy code: CPV for UK/EU, PSC for US. */
  classification?: string;
  valueAmount?: number;
  valueCurrency?: string;
  publishedAt: Date;
  noticeUrl: string;
}

/**
 * One public procurement feed. Same shape as `AtsProvider`: the source knows
 * nothing about which country's portal it is talking to.
 */
export interface ProcurementProvider {
  readonly name: 'uk-contracts-finder' | 'ted-eu' | 'sam-gov';
  /** Returns [] rather than throwing when a feed is unavailable or changes shape. */
  fetchSince(since: Date): Promise<ProcurementNotice[]>;
}

export const PROCUREMENT_PROVIDER = Symbol('PROCUREMENT_PROVIDER');
