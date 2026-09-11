export { OpportunityModule } from './opportunity.module.js';
export { OpportunityConfigService } from './opportunity-config.service.js';
export {
  ARCHETYPE_KEYS,
  EVIDENCE_LEVELS,
  ATTRIBUTION_LEVELS,
  archetypeConfigSchema,
  capabilityMapSchema,
  triggerConfigSchema,
  evidenceConfigSchema,
} from './opportunity-config.schemas.js';
export type {
  ArchetypeKey,
  EvidenceLevel,
  AttributionLevel,
  ArchetypeConfig,
  CapabilityMap,
  TriggerConfig,
  EvidenceConfig,
} from './opportunity-config.schemas.js';
export type {
  CompiledTriggerFamily,
  CompiledEvidenceOverride,
} from './opportunity-config.service.js';
