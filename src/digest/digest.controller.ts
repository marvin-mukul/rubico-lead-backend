import { Controller, Get, Query } from '@nestjs/common';
import { InternalOnly } from '../common/auth/index.js';
import { ZodValidationPipe } from '../common/validation/index.js';
import { digestQuerySchema, type DigestQuery } from '../api/dto.js';
import { DigestService } from './digest.service.js';

/** §8.1 — `GET /internal/digest/daily`, pulled by n8n (FR-B12). */
@Controller('internal/digest')
@InternalOnly()
export class DigestController {
  constructor(private readonly digest: DigestService) {}

  @Get('daily')
  daily(@Query(new ZodValidationPipe(digestQuerySchema)) query: DigestQuery) {
    return this.digest.daily(query.date);
  }
}
