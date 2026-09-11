import { readFileSync } from 'node:fs';
import { SIGNAL_TYPES } from '../common/domain/index.js';
import {
  ARCHETYPE_KEYS,
  archetypeConfigSchema,
  capabilityMapSchema,
  evidenceConfigSchema,
  triggerConfigSchema,
} from './opportunity-config.schemas.js';

const read = (file: string): unknown => JSON.parse(readFileSync(`config/${file}`, 'utf8'));

/**
 * The shipped JSON config must satisfy its own schema, and the four files
 * must agree with each other. These are cheap checks that catch the class of
 * error that would otherwise surface mid-run on one unlucky record.
 */
describe('opportunity JSON config (§2.3)', () => {
  const archetypes = archetypeConfigSchema.parse(read('archetypes.json'));
  const capabilities = capabilityMapSchema.parse(read('capability-map.json'));
  const triggers = triggerConfigSchema.parse(read('triggers.json'));
  const evidence = evidenceConfigSchema.parse(read('evidence.json'));

  it('every shipped file parses against its schema', () => {
    expect(archetypes.archetypes.length).toBeGreaterThan(0);
    expect(Object.keys(capabilities.families).length).toBeGreaterThan(0);
    expect(triggers.families.length).toBeGreaterThan(0);
    expect(Object.keys(evidence.bandCeiling).length).toBe(5);
  });

  it('declares all four verified archetypes, including the hero offer', () => {
    const keys = archetypes.archetypes.map((a) => a.key).sort();
    expect(keys).toEqual([...ARCHETYPE_KEYS].sort());
    // ai_code_to_production is Rubico's hero offer and was entirely absent
    // from the engine before this.
    const hero = archetypes.archetypes.find((a) => a.key === 'ai_code_to_production');
    expect(hero?.subTypes).toHaveLength(6);
  });

  // Cross-file: a trigger pointing at an archetype that does not exist would
  // produce a candidate the classifier cannot act on.
  it('every archetype a trigger family suggests actually exists', () => {
    const declared = new Set(archetypes.archetypes.map((a) => a.key));
    for (const family of triggers.families) {
      for (const key of family.archetypes) {
        expect(declared.has(key), `${family.key} -> ${key}`).toBe(true);
      }
    }
  });

  // Cross-file: a signal type with no evidence default would silently get
  // no strength, and therefore no band ceiling.
  it('every signal type has a default evidence strength', () => {
    for (const type of SIGNAL_TYPES) {
      expect(evidence.defaultBySignalType[type], `missing default for ${type}`).toBeDefined();
    }
  });

  it('treats context signals as E0 and a tender as E3', () => {
    // §2.5.5 / §2.5.2: running a platform, or raising money, is context —
    // never an opportunity on its own.
    expect(evidence.defaultBySignalType['F-PLAT']).toBe('E0');
    expect(evidence.defaultBySignalType['F-LEG']).toBe('E0');
    expect(evidence.defaultBySignalType.S1).toBe('E0');
    // A tender is a declared requirement with a budget and a deadline.
    expect(evidence.defaultBySignalType.S6).toBe('E3');
  });

  it('caps E0 at ignore, so context can never create an opportunity', () => {
    expect(evidence.bandCeiling.E0).toBe('ignore');
    expect(evidence.bandCeiling.E1).toBe('investigate');
    expect(evidence.bandCeiling.E3).toBe('immediate');
  });

  it('has a trigger family for the hero offer', () => {
    const ai = triggers.families.find((f) => f.archetypes.includes('ai_code_to_production'));
    expect(ai).toBeDefined();
    expect(ai!.patterns.some((p) => /lovable|replit|bolt/i.test(p))).toBe(true);
  });

  it('lists the capabilities the engine used to be blind to', () => {
    const all = Object.values(capabilities.families).flat().join(' ').toLowerCase();
    for (const capability of ['woocommerce', 'shopify', 'magento', 'laravel', 'flutter', 'swift']) {
      expect(all, `capability map is missing ${capability}`).toContain(capability);
    }
  });
});

describe('config schema validation', () => {
  it('rejects a pattern that is not a valid regular expression', () => {
    const result = triggerConfigSchema.safeParse({
      families: [
        { key: 'x', label: 'x', archetypes: ['idea_to_product'], patterns: ['([unclosed'] },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('valid regular expression');
  });

  it('rejects an unknown archetype key', () => {
    const result = triggerConfigSchema.safeParse({
      families: [{ key: 'x', label: 'x', archetypes: ['make_it_shiny'], patterns: ['a'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown evidence level', () => {
    const result = evidenceConfigSchema.safeParse({
      levels: {},
      defaultBySignalType: { S1: 'E9' },
      overrides: [],
      bandCeiling: {},
      attributionLevels: {},
    });
    expect(result.success).toBe(false);
  });
});
