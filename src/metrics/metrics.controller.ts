import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SessionAuth } from '../common/auth/index.js';
import { ZodValidationPipe } from '../common/validation/index.js';
import {
  funnelResponseSchema,
  metricsRangeQuerySchema,
  spendResponseSchema,
  type MetricsRangeQuery,
} from '../api/dto.js';
import { ApiZodOk, ApiZodQuery } from '../api/openapi.js';
import { MetricsService } from './metrics.service.js';

@ApiTags('metrics')
@Controller('api/metrics')
@SessionAuth()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** A8: M1–M8 without manual queries. */
  @Get('funnel')
  @ApiZodQuery(metricsRangeQuerySchema)
  @ApiZodOk(funnelResponseSchema)
  funnel(@Query(new ZodValidationPipe(metricsRangeQuerySchema)) query: MetricsRangeQuery) {
    return this.metrics.funnel(this.metrics.resolveRange(query.from, query.to));
  }

  @Get('spend')
  @ApiZodOk(spendResponseSchema)
  spend() {
    return this.metrics.spendSummary();
  }
}
