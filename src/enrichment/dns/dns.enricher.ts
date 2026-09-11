import { Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import type { CompanyModel as Company } from '../../generated/prisma/models.js';
import type { Enricher, EnrichmentResult } from '../enricher.interface.js';

const TIMEOUT_MS = 5_000;

/** Mail host suffix → provider. First match wins, so order longest-first. */
const MAIL_PROVIDERS: Array<[RegExp, string]> = [
  [/aspmx\.l\.google\.com|googlemail\.com|google\.com$/i, 'google-workspace'],
  [/protection\.outlook\.com|outlook\.com$/i, 'microsoft-365'],
  [/pphosted\.com|proofpoint\.com$/i, 'proofpoint'],
  [/mimecast\.com$/i, 'mimecast'],
  [/messagelabs\.com$/i, 'symantec'],
  [/zoho\.(com|eu)$/i, 'zoho'],
  [/secureserver\.net$/i, 'godaddy'],
  [/mail\.protection\.outlook/i, 'microsoft-365'],
];

/** Nameserver suffix → DNS/host provider, a rough proxy for infrastructure age. */
const DNS_PROVIDERS: Array<[RegExp, string]> = [
  [/cloudflare\.com$/i, 'cloudflare'],
  [/awsdns/i, 'aws-route53'],
  [/azure-dns/i, 'azure'],
  [/googledomains\.com$|google\.com$/i, 'google'],
  [/domaincontrol\.com$/i, 'godaddy'],
  [/registrar-servers\.com$/i, 'namecheap'],
  [/dnsmadeeasy\.com$/i, 'dns-made-easy'],
];

function classify(values: string[], table: Array<[RegExp, string]>): string | undefined {
  for (const value of values) {
    for (const [pattern, provider] of table) {
      if (pattern.test(value)) return provider;
    }
  }
  return undefined;
}

/**
 * DNS-derived infrastructure hints. Free, fast, and unlike a homepage fetch
 * it still works for sites that block automated clients.
 */
@Injectable()
export class DnsEnricher implements Enricher {
  readonly name = 'dns';
  readonly cost = 'free' as const;

  async enrich(company: Company): Promise<EnrichmentResult> {
    const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    const domain = company.canonicalDomain;

    // Each lookup is independently optional: a domain with no MX still has
    // useful NS and TXT records.
    const [mx, ns, txt] = await Promise.all([
      resolver.resolveMx(domain).catch(() => []),
      resolver.resolveNs(domain).catch(() => []),
      resolver.resolveTxt(domain).catch(() => []),
    ]);

    const mxHosts = mx.map((record) => record.exchange.toLowerCase());
    const nsHosts = ns.map((host) => host.toLowerCase());
    const txtRecords = txt.map((chunks) => chunks.join('')).slice(0, 20);

    const detectedStack: Record<string, unknown> = {
      dnsCheckedAt: new Date().toISOString(),
      hasMx: mxHosts.length > 0,
    };

    const mailProvider = classify(mxHosts, MAIL_PROVIDERS);
    const dnsProvider = classify(nsHosts, DNS_PROVIDERS);
    if (mailProvider) detectedStack.mailProvider = mailProvider;
    if (dnsProvider) detectedStack.dnsProvider = dnsProvider;

    // SPF referencing a vendor is a cheap signal of what a company runs on.
    const spf = txtRecords.find((record) => record.startsWith('v=spf1'));
    if (spf) {
      detectedStack.spfIncludes = spf
        .split(/\s+/)
        .filter((token) => token.startsWith('include:'))
        .map((token) => token.slice('include:'.length))
        .slice(0, 10);
    }

    // Self-hosted mail is a FACT about their infrastructure, not a defect.
    // It was previously written to `legacyFlags`, which raised F-LEG and
    // produced a modernisation pitch — the same §2.5.5 error as flagging
    // WordPress. wordpress.org and craigslist.org were both flagged legacy on
    // this rule alone. Technology presence does not imply technology pain.
    if (mxHosts.length > 0 && !mailProvider && mxHosts.some((host) => host.endsWith(domain))) {
      detectedStack.selfHostedMail = true;
    }

    return { detectedStack };
  }
}
