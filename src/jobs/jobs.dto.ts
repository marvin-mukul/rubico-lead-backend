import { z } from 'zod';

/** Body of POST /internal/jobs/:jobName/run (§8.1). */
export const runJobBodySchema = z
  .object({
    since: z.iso.datetime({ offset: true }).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export type RunJobBody = z.infer<typeof runJobBodySchema>;
