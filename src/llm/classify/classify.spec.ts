import { z } from 'zod';
import { testConfig } from '../../../test/support/config.factory.js';
import { AppConfigService } from '../../common/config/app-config.service.js';
import { MeteredClient } from '../../common/metering/index.js';
import { PrismaService } from '../../common/prisma/index.js';
import { OpportunityConfigService } from '../../opportunity/index.js';
import { toGeminiSchema } from '../gemini/gemini.provider.js';
import { LLM_CLASSIFY_PROVIDER, type LlmProvider } from '../llm-provider.interface.js';
import { buildClassifySystemPrompt } from '../prompts.js';
import { briefSchema, classificationSchema, type Classification } from '../schemas.js';
import { ClassifyService, buildClassifyPrompt } from './classify.service.js';

void LLM_CLASSIFY_PROVIDER;

const opportunityConfig = new OpportunityConfigService(testConfig());
const CLASSIFY_SYSTEM_PROMPT = buildClassifySystemPrompt(opportunityConfig);

const service = new ClassifyService(
  null as unknown as LlmProvider,
  null as unknown as MeteredClient,
  null as unknown as AppConfigService,
  null as unknown as PrismaService,
  opportunityConfig,
);

const classification = (overrides: Partial<Classification> = {}): Classification => ({
  has_rubico_opportunity: true,
  evidence_sufficient: true,
  likely_need: 'Modernise an ASP.NET Web Forms product',
  archetype: 'fix_slowing_software',
  rubico_capabilities: ['Legacy modernisation'],
  why_this_lead: [
    {
      observation: 'Active hiring for engineering roles',
      implies: 'The team cannot keep pace with the existing codebase',
      capability: 'Legacy modernisation',
      signal_ids: ['sig_1'],
    },
  ],
  confidence: 'medium',
  reasoning: 'Legacy stack plus active hiring.',
  cited_signal_ids: ['sig_1'],
  ...overrides,
});

const KNOWN_IDS = new Set(['sig_1']);

/**
 * Acceptance A6: "Classifier returns `false` for a deliberately irrelevant
 * company." FR-AI5 adds that both refusals must discard the record *before*
 * scoring — a classifier that never refuses is not a filter and doubles
 * downstream cost.
 */
describe('ClassifyService.evaluate (FR-AI5)', () => {
  it('keeps a company with a real, evidenced opportunity', () => {
    const outcome = service.evaluate(classification(), KNOWN_IDS);
    expect(outcome.keep).toBe(true);
    expect(outcome.discardReason).toBeUndefined();
  });

  it('discards when there is no Rubico opportunity', () => {
    const outcome = service.evaluate(classification({ has_rubico_opportunity: false }), KNOWN_IDS);
    expect(outcome.keep).toBe(false);
    expect(outcome.discardReason).toBe('no_rubico_opportunity');
  });

  it('discards when the evidence is too thin, even if the fit looks fine', () => {
    const outcome = service.evaluate(
      classification({ has_rubico_opportunity: true, evidence_sufficient: false }),
      KNOWN_IDS,
    );
    expect(outcome.keep).toBe(false);
    expect(outcome.discardReason).toBe('insufficient_evidence');
  });

  it('discards on either refusal independently', () => {
    expect(
      service.evaluate(
        classification({ has_rubico_opportunity: false, evidence_sufficient: false }),
        KNOWN_IDS,
      ).keep,
    ).toBe(false);
  });

  // P22: FR-AI6 extended to the why-this-lead chain — a hallucinated citation
  // discards the record before scoring, the same as a brief's bad citation.
  it('discards when cited_signal_ids names an id that is not a real signal', () => {
    const outcome = service.evaluate(
      classification({ cited_signal_ids: ['sig_invented'] }),
      KNOWN_IDS,
    );
    expect(outcome.keep).toBe(false);
    expect(outcome.discardReason).toBe('invalid_citation');
  });

  it('discards when a why_this_lead step cites an id that is not a real signal', () => {
    const outcome = service.evaluate(
      classification({
        why_this_lead: [
          {
            observation: 'x',
            implies: 'y',
            capability: 'z',
            signal_ids: ['sig_invented'],
          },
        ],
      }),
      KNOWN_IDS,
    );
    expect(outcome.keep).toBe(false);
    expect(outcome.discardReason).toBe('invalid_citation');
  });
});

describe('classification schema (FR-AI2)', () => {
  it('requires both refusal flags, so the model must take a position', () => {
    const { has_rubico_opportunity, evidence_sufficient, ...withoutFlags } = classification();
    void has_rubico_opportunity;
    void evidence_sufficient;
    expect(classificationSchema.safeParse(withoutFlags).success).toBe(false);
  });

  it('accepts a well-formed refusal', () => {
    const refusal = classificationSchema.safeParse({
      has_rubico_opportunity: false,
      evidence_sufficient: false,
      likely_need: '',
      archetype: 'none',
      rubico_capabilities: [],
      why_this_lead: [],
      confidence: 'high',
      reasoning: 'A pre-product hardware startup; nothing Rubico sells applies.',
      cited_signal_ids: [],
    });
    expect(refusal.success).toBe(true);
  });

  it('rejects an invented archetype rather than passing it downstream', () => {
    expect(
      classificationSchema.safeParse({ ...classification(), archetype: 'blockchain' }).success,
    ).toBe(false);
  });

  it('accepts ai_code_to_production — the hero offer the old enum had no room for', () => {
    expect(
      classificationSchema.safeParse(classification({ archetype: 'ai_code_to_production' }))
        .success,
    ).toBe(true);
  });

  it('requires each why_this_lead step to cite at least one signal', () => {
    expect(
      classificationSchema.safeParse(
        classification({
          why_this_lead: [
            { observation: 'x', implies: 'y', capability: 'z', signal_ids: [] },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('prompt construction (FR-AI4)', () => {
  const company = {
    id: 'c1',
    canonicalDomain: 'acme.com',
    name: 'Acme',
    industry: 'SaaS',
    legacyFlags: { 'aspnet-webforms': true, checkedAt: '2026-09-01' },
  };
  const signals = [
    {
      id: 'sig_1',
      type: 'S1',
      eventDate: new Date('2026-09-01T00:00:00Z'),
      sourceName: 'sec-edgar',
      sourceUrl: 'https://sec.gov/x',
      excerpt: 'Form D filed',
    },
  ];

  it('puts every varying fact in the user message, never the cached prefix', () => {
    const user = buildClassifyPrompt(company, signals);
    expect(user).toContain('acme.com');
    expect(user).toContain('sig_1');

    // If any of these leaked into the system prompt, the cache would miss on
    // every call and the bill would rise with nothing failing.
    expect(CLASSIFY_SYSTEM_PROMPT).not.toContain('acme.com');
    expect(CLASSIFY_SYSTEM_PROMPT).not.toContain('sig_1');
  });

  it('is byte-identical across calls, so it actually caches', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toBe(CLASSIFY_SYSTEM_PROMPT.trim());
    expect(/\d{4}-\d{2}-\d{2}T/.test(CLASSIFY_SYSTEM_PROMPT)).toBe(false);
  });

  it('lists the signal ids the model is allowed to cite', () => {
    expect(buildClassifyPrompt(company, signals)).toMatch(/id: sig_1/);
  });

  it('drops noisy timestamp keys from stack summaries', () => {
    expect(buildClassifyPrompt(company, signals)).toContain('legacy flags: aspnet-webforms');
    expect(buildClassifyPrompt(company, signals)).not.toContain('checkedAt');
  });
});

describe('toGeminiSchema', () => {
  it('strips the JSON Schema keywords Gemini rejects', () => {
    const converted = JSON.stringify(
      toGeminiSchema(z.toJSONSchema(classificationSchema, { target: 'draft-2020-12' })),
    );
    expect(converted).not.toContain('$schema');
    expect(converted).not.toContain('additionalProperties');
  });

  it('keeps the parts that carry meaning', () => {
    const converted = toGeminiSchema(
      z.toJSONSchema(briefSchema, { target: 'draft-2020-12' }),
    ) as Record<string, unknown>;
    expect(converted).toHaveProperty('properties');
    expect(converted).toHaveProperty('required');
    expect(JSON.stringify(converted)).toContain('suggested_opening_line');
  });
});
