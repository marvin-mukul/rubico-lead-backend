import { readFileSync } from 'node:fs';

/**
 * Guards the committed contract, `openapi.json`, as a document — not the
 * helpers that build it.
 *
 * The failure this exists for is silent and one-directional: inlining a
 * response schema at its call site produces a perfectly *valid* OpenAPI
 * document whose `components.schemas` is empty. Nothing on this side breaks.
 * The damage lands in the frontend, where `openapi-typescript` emits
 * `schemas: never`, leaving it no name for any response and no option but to
 * hand-write the shapes — which is exactly what frontend FR-W7 forbids.
 *
 * Read from disk rather than rebuilt in-process, because the committed file
 * is what the frontend actually generates from. A test that regenerates the
 * document would pass on a stale `openapi.json`.
 */
describe('openapi.json contract (FR-B17/B18)', () => {
  const document = JSON.parse(readFileSync('openapi.json', 'utf8')) as {
    paths: Record<string, Record<string, OperationLike>>;
    components?: { schemas?: Record<string, unknown> };
  };

  interface OperationLike {
    responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    requestBody?: { content?: Record<string, { schema?: unknown }> };
  }

  const schemas = document.components?.schemas ?? {};

  /** Every (path, method, where, schema) pair the document declares a body for. */
  const bodySchemas = (): { where: string; schema: unknown }[] => {
    const found: { where: string; schema: unknown }[] = [];
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          const schema = response.content?.['application/json']?.schema;
          if (schema) found.push({ where: `${method.toUpperCase()} ${path} -> ${status}`, schema });
        }
        const request = operation.requestBody?.content?.['application/json']?.schema;
        if (request) found.push({ where: `${method.toUpperCase()} ${path} <- body`, schema: request });
      }
    }
    return found;
  };

  it('documents at least one path', () => {
    // A document with no paths would pass every assertion below vacuously.
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it('registers named components rather than inlining schemas', () => {
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('references every request and response body by $ref', () => {
    const inlined = bodySchemas()
      .filter(({ schema }) => !(typeof schema === 'object' && schema !== null && '$ref' in schema))
      .map(({ where }) => where);

    // If this fails, an ApiZod* decorator was called without a component name.
    expect(inlined, `inlined instead of $ref: ${inlined.join(', ')}`).toEqual([]);
  });

  it('resolves every $ref it emits', () => {
    const dangling = bodySchemas()
      .map(({ where, schema }) => ({
        where,
        ref: (schema as { $ref?: string }).$ref ?? '',
      }))
      .filter(({ ref }) => !ref.startsWith('#/components/schemas/'))
      .concat(
        bodySchemas()
          .map(({ where, schema }) => ({ where, ref: (schema as { $ref?: string }).$ref ?? '' }))
          .filter(({ ref }) => ref.startsWith('#/components/schemas/'))
          .filter(({ ref }) => !(ref.slice('#/components/schemas/'.length) in schemas)),
      )
      .map(({ where, ref }) => `${where} -> ${ref}`);

    expect(dangling, `unresolvable: ${dangling.join(', ')}`).toEqual([]);
  });

  it('leaves no component unreferenced', () => {
    const used = new Set(
      bodySchemas()
        .map(({ schema }) => (schema as { $ref?: string }).$ref ?? '')
        .filter((ref) => ref.startsWith('#/components/schemas/'))
        .map((ref) => ref.slice('#/components/schemas/'.length)),
    );
    // An orphan means a registered schema no longer matches any route — a
    // rename that got halfway, or a deleted endpoint.
    const orphans = Object.keys(schemas).filter((name) => !used.has(name));
    expect(orphans, `registered but unreferenced: ${orphans.join(', ')}`).toEqual([]);
  });

  it('documents both session transports', () => {
    const security = (document as unknown as {
      components?: { securitySchemes?: Record<string, { type?: string; in?: string }> };
    }).components?.securitySchemes;

    expect(security?.session).toMatchObject({ type: 'apiKey', in: 'cookie' });
    expect(security?.sessionBearer).toMatchObject({ type: 'http' });
  });

  it('publishes only /api/*, never the internal surface', () => {
    const leaked = Object.keys(document.paths).filter((path) => !path.startsWith('/api/'));
    expect(leaked, `internal routes in the public contract: ${leaked.join(', ')}`).toEqual([]);
  });
});
