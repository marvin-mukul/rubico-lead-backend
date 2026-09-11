import { AppConfigService } from '../common/config/app-config.service.js';
import { testConfig } from '../../test/support/config.factory.js';
import { OpportunityConfigService } from './opportunity-config.service.js';
import { OpportunityTriggerService } from './trigger.service.js';
import type { TriggerableSignal } from './trigger.service.js';

const service = new OpportunityTriggerService(
  new OpportunityConfigService(testConfig() as AppConfigService),
);

let n = 0;
const sig = (over: Partial<TriggerableSignal> = {}): TriggerableSignal => ({
  id: `s${++n}`,
  type: 'S3',
  excerpt: '',
  ...over,
});

/**
 * The zero-cost gate (§2.2). Tuned for recall by decision: a false negative
 * silently drops a real opportunity and is unrecoverable; a false positive
 * costs one classify call at ~$0.0002.
 */
describe('OpportunityTriggerService', () => {
  describe('opens the gate on real evidence', () => {
    it.each([
      ['Provision of HR & MIS system', 'custom-software'],
      ['Website redesign and CMS migration', 'web-build'],
      ['Replatforming our ecommerce store', 'ecommerce'],
      ['Mobile app for parents', 'mobile-app'],
      ['Legacy system modernisation programme', 'modernisation'],
      ['Cloud migration services', 'cloud-devops'],
      ['Systems integration and API work', 'integration-data'],
    ])('passes %s', (excerpt, family) => {
      const verdict = service.evaluate([sig({ excerpt })]);
      expect(verdict.passed).toBe(true);
      expect(verdict.families).toContain(family);
    });

    it('recognises the hero offer from AI-tool vocabulary', () => {
      for (const excerpt of [
        'Built it in Lovable, now it needs to be production ready',
        'We vibe coded this and need it secured',
        'Shipping AI generated code to production',
      ]) {
        const verdict = service.evaluate([sig({ excerpt })]);
        expect(verdict.passed).toBe(true);
        expect(verdict.archetypes).toContain('ai_code_to_production');
      }
    });

    it('recognises technology job titles, which is how non-software companies show up', () => {
      for (const excerpt of [
        'Head of Ecommerce — Manchester',
        'IT Manager — Leeds City Council',
        'Salesforce Administrator — Bristol',
        'Digital Transformation Manager',
        'Senior Software Engineer — Remote',
      ]) {
        const verdict = service.evaluate([sig({ type: 'S2', excerpt })]);
        expect(verdict.passed, excerpt).toBe(true);
      }
    });

    it('reads the subject as well as the excerpt', () => {
      const verdict = service.evaluate([
        sig({ type: 'S2', subject: 'hiring Lead Developer', excerpt: 'Remote' }),
      ]);
      expect(verdict.passed).toBe(true);
    });
  });

  describe('keeps the gate shut', () => {
    it.each([
      'Kingsmoore Ward Refurbishment works',
      'Procurement of Handheld 3D SLAM scanner',
      'Supply of school meals',
      'Ad Sales Lead — Remote',
      'Grounds maintenance framework',
    ])('rejects %s', (excerpt) => {
      expect(service.evaluate([sig({ excerpt })]).passed).toBe(false);
    });

    it('rejects a company with no signals at all', () => {
      expect(service.evaluate([]).passed).toBe(false);
    });

    // §2.5.5 — running WordPress tells you what they have, not that they
    // need anything. A standing property must not open a paid call.
    it('does not let a standing property open the gate', () => {
      const verdict = service.evaluate([
        sig({ type: 'F-PLAT', excerpt: 'Rubico-serviced platform: wordpress' }),
        sig({ type: 'F-LEG', excerpt: 'Legacy markers: angularjs' }),
      ]);
      expect(verdict.passed).toBe(false);
      // Still reported as context — it just cannot be the reason we spend.
      expect(verdict.families.length).toBeGreaterThan(0);
    });

    it('opens once a real event accompanies the standing property', () => {
      const verdict = service.evaluate([
        sig({ type: 'F-PLAT', excerpt: 'Rubico-serviced platform: wordpress' }),
        sig({ type: 'S6', excerpt: 'Website replatforming tender' }),
      ]);
      expect(verdict.passed).toBe(true);
    });
  });

  /**
   * A CPV-72 tender is technology work by the code it was filed under.
   * Re-deriving that from its title only loses real leads — a live notice
   * titled "Software programming and consultancy services" was being
   * rejected before this.
   */
  describe('pre-qualified signal types', () => {
    it('passes a procurement signal whose title matches no phrase', () => {
      const verdict = service.evaluate([
        sig({ type: 'S6', excerpt: 'Ramavtal avseende konsulttjänster' }),
      ]);
      expect(verdict.passed).toBe(true);
    });

    it('passes first-party inbound regardless of wording', () => {
      expect(service.evaluate([sig({ type: 'S5', excerpt: 'contact form' })]).passed).toBe(true);
    });

    it('does not pre-qualify a standing property even if listed', () => {
      expect(service.evaluate([sig({ type: 'F-PLAT', excerpt: 'anything' })]).passed).toBe(false);
    });
  });

  describe('what it reports', () => {
    it('names the literal text that matched, so a decision is inspectable', () => {
      const verdict = service.evaluate([sig({ excerpt: 'Our legacy CRM is unusable' })]);
      expect(verdict.matches.length).toBeGreaterThan(0);
      expect(verdict.matches.map((m) => m.matched.toLowerCase())).toContain('legacy');
    });

    it('suggests candidate archetypes without deciding', () => {
      const verdict = service.evaluate([sig({ excerpt: 'Legacy platform rewrite' })]);
      expect(verdict.archetypes).toContain('fix_slowing_software');
    });

    it('collects families across several signals', () => {
      const verdict = service.evaluate([
        sig({ excerpt: 'Mobile app for members' }),
        sig({ excerpt: 'Data warehouse migration' }),
      ]);
      expect(verdict.families).toEqual(expect.arrayContaining(['mobile-app', 'integration-data']));
    });
  });
});
