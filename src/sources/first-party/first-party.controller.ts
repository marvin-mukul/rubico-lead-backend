import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { z } from 'zod';
import { InternalOnly } from '../../common/auth/index.js';
import { IdempotencyKey, RequireIdempotencyKey } from '../../common/idempotency/index.js';
import { ZodValidationPipe } from '../../common/validation/index.js';
import { MutableJobContext } from '../../jobs/index.js';
import { IngestionService } from '../ingestion.service.js';

export const firstPartyBodySchema = z
  .object({
    domain: z.string().min(1),
    pageUrl: z.url(),
    occurredAt: z.iso.datetime({ offset: true }),
    formType: z.string().min(1),
    email: z.email().optional(),
  })
  .strict();

export type FirstPartyBody = z.infer<typeof firstPartyBodySchema>;

/**
 * `POST /internal/ingest/first-party` (§8.1, signal type S5).
 *
 * The one push-shaped source: a form fill on our own site is an event we are
 * told about, not something to poll for. Everything else is pulled.
 *
 * Handled inline rather than as a job — it is a single record, and FR-B5's
 * "return 202 and do the work later" exists because ingestion can outlast an
 * HTTP timeout, which one row cannot.
 */
@Controller('internal/ingest')
@InternalOnly()
export class FirstPartyController {
  private readonly logger = new Logger(FirstPartyController.name);

  constructor(private readonly ingestion: IngestionService) {}

  @Post('first-party')
  @HttpCode(202)
  @RequireIdempotencyKey()
  async ingest(
    @Body(new ZodValidationPipe(firstPartyBodySchema)) body: FirstPartyBody,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<{ accepted: true }> {
    // The idempotency key is the caller's dedupe handle; the signal's own
    // dedupeHash is what actually prevents a duplicate row, so a replay is
    // safe whichever arrives first.
    const context = new MutableJobContext(`first-party:${idempotencyKey}`, {}, false);

    await this.ingestion.ingest(
      [
        {
          domain: body.domain,
          companyName: body.domain,
          type: 'S5',
          eventDate: new Date(body.occurredAt),
          sourceUrl: body.pageUrl,
          sourceName: 'first-party',
          excerpt: `${body.formType} submitted on ${body.pageUrl}`,
          subject: `first-party ${body.formType}`,
          raw: { ...body, idempotencyKey },
        },
      ],
      context,
    );

    this.logger.log(`first-party ${body.formType} from ${body.domain} ${JSON.stringify(context.counts)}`);
    return { accepted: true };
  }
}
