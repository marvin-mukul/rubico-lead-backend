import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service.js';
import { loadJsonConfig } from '../common/config/json-config.js';
import {
  archetypeConfigSchema,
  capabilityMapSchema,
  evidenceConfigSchema,
  triggerConfigSchema,
  type ArchetypeConfig,
  type ArchetypeKey,
  type CapabilityMap,
  type EvidenceConfig,
  type TriggerConfig,
} from './opportunity-config.schemas.js';

/** A trigger family with its patterns already compiled. */
export interface CompiledTriggerFamily {
  key: string;
  label: string;
  archetypes: ArchetypeKey[];
  patterns: RegExp[];
}

export interface CompiledEvidenceOverride {
  strength: string;
  note?: string;
  patterns: RegExp[];
}

/**
 * Loads the four JSON config files once at construction and compiles every
 * regex up front.
 *
 * Compiling once matters: the trigger gate runs these patterns against every
 * signal of every candidate company on every pipeline run. Recompiling 114
 * regexes per signal would make the free gate the slowest thing in the run.
 */
@Injectable()
export class OpportunityConfigService {
  private readonly logger = new Logger(OpportunityConfigService.name);

  readonly archetypes: ArchetypeConfig;
  readonly capabilities: CapabilityMap;
  readonly triggers: TriggerConfig;
  readonly evidence: EvidenceConfig;

  readonly triggerFamilies: CompiledTriggerFamily[];
  readonly evidenceOverrides: CompiledEvidenceOverride[];

  constructor(config: AppConfigService) {
    const paths = config.opportunityConfigPaths;

    this.archetypes = loadJsonConfig(paths.archetypes, archetypeConfigSchema, 'archetype config');
    this.capabilities = loadJsonConfig(paths.capabilityMap, capabilityMapSchema, 'capability map');
    this.triggers = loadJsonConfig(paths.triggers, triggerConfigSchema, 'trigger config');
    this.evidence = loadJsonConfig(paths.evidence, evidenceConfigSchema, 'evidence config');

    this.triggerFamilies = this.triggers.families.map((family) => ({
      key: family.key,
      label: family.label,
      archetypes: [...family.archetypes],
      patterns: family.patterns.map((source) => new RegExp(source, 'i')),
    }));

    this.evidenceOverrides = this.evidence.overrides.map((override) => ({
      strength: override.strength,
      ...(override.note ? { note: override.note } : {}),
      patterns: override.patterns.map((source) => new RegExp(source, 'i')),
    }));

    const patternCount = this.triggerFamilies.reduce((n, f) => n + f.patterns.length, 0);
    this.logger.log(
      `Loaded ${this.triggerFamilies.length} trigger families (${patternCount} patterns), ` +
        `${this.archetypes.archetypes.length} archetypes, ` +
        `${Object.keys(this.capabilities.families).length} capability families`,
    );
  }

  archetype(key: ArchetypeKey) {
    return this.archetypes.archetypes.find((entry) => entry.key === key);
  }

  /** Every capability Rubico lists, flattened — used by the classify prompt. */
  allCapabilities(): string[] {
    return Object.values(this.capabilities.families).flat();
  }
}
