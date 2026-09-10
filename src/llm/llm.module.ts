import { Module } from '@nestjs/common';
import { AppConfigService } from '../common/config/app-config.service.js';
import { AnthropicProvider } from './anthropic/anthropic.provider.js';
import { BriefService } from './brief/brief.service.js';
import { ClassifyService } from './classify/classify.service.js';
import { GeminiProvider } from './gemini/gemini.provider.js';
import { LLM_BRIEF_PROVIDER, LLM_CLASSIFY_PROVIDER, type LlmProvider } from './llm-provider.interface.js';

/**
 * FR-B20 / FR-AI1: provider and model selection is config, not code. Both
 * providers are constructed either way; which one each step resolves to is a
 * `.env` line, so switching costs a restart rather than a deploy.
 */
const pick = (name: string, gemini: GeminiProvider, anthropic: AnthropicProvider): LlmProvider =>
  name === 'anthropic' ? anthropic : gemini;

@Module({
  providers: [
    GeminiProvider,
    AnthropicProvider,
    {
      provide: LLM_CLASSIFY_PROVIDER,
      inject: [AppConfigService, GeminiProvider, AnthropicProvider],
      useFactory: (config: AppConfigService, g: GeminiProvider, a: AnthropicProvider) =>
        pick(config.classify.provider, g, a),
    },
    {
      provide: LLM_BRIEF_PROVIDER,
      inject: [AppConfigService, GeminiProvider, AnthropicProvider],
      useFactory: (config: AppConfigService, g: GeminiProvider, a: AnthropicProvider) =>
        pick(config.brief.provider, g, a),
    },
    ClassifyService,
    BriefService,
  ],
  exports: [ClassifyService, BriefService, LLM_CLASSIFY_PROVIDER, LLM_BRIEF_PROVIDER],
})
export class LlmModule {}
