/**
 * Seam 6 of the eight (§4). **Phase 1 fills this. Zero implementations in
 * Phase 0** — §14 lists outreach sending as explicitly out of scope,
 * interface only.
 *
 * It is declared now, before anything needs it, so the Phase 1 upgrade lands
 * as a provider class rather than a refactor of whatever grew in its place.
 */
export interface Lead {
  id: string;
  companyId: string;
}

export interface Contact {
  id: string;
  email?: string | null;
}

export interface SendResult {
  accepted: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface OutreachSender {
  send(lead: Lead, contact: Contact, body: string): Promise<SendResult>;
}

export const OUTREACH_SENDER = Symbol('OUTREACH_SENDER');
