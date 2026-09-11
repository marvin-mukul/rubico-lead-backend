import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { z, type ZodObject, type ZodType } from 'zod';

/**
 * §9: "Zod schemas remain the runtime validators. `@nestjs/swagger` documents
 * the DTOs. Where they would drift, generate the OpenAPI schema from the Zod
 * schema rather than maintaining two definitions."
 *
 * These helpers are that generation step. Every `/api/*` DTO is declared once
 * as Zod; the OpenAPI document is derived from it, so the contract the
 * frontend generates types from cannot disagree with what the server accepts.
 */

/**
 * The swagger package does not export its SchemaObject type from a stable
 * path, so the OpenAPI schema is typed structurally here rather than pinned
 * to an internal module that a patch release could move.
 */
export type OpenApiSchema = Record<string, unknown>;

/**
 * `io` matters. For a field with a default, the INPUT schema makes it
 * optional (the client may omit it) while the OUTPUT schema makes it
 * required (the server always returns it). Generating a request with
 * `io: 'output'` would tell the frontend that `page` and `pageSize` are
 * mandatory, which is the opposite of true.
 */
export function openApiSchema(schema: ZodType, io: 'input' | 'output' = 'output'): OpenApiSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as OpenApiSchema;
}

/**
 * Named schema components (FR-B18).
 *
 * Inlining every schema at its call site produces a valid document that is
 * useless to a client generator: `components.schemas` comes out empty, so
 * `openapi-typescript` emits `schemas: never` and the frontend has no name
 * for any response it receives. Its alternative is to hand-write the shapes,
 * which is precisely what frontend FR-W7 forbids.
 *
 * So every documented body and response is registered under a name and
 * referenced by `$ref`. The registry is populated as the decorators evaluate
 * — that is, when the controller module is imported — and merged into the
 * document by `buildOpenApiDocument`.
 */
const schemaComponents = new Map<string, OpenApiSchema>();

/**
 * Registers `schema` as a component and returns a `$ref` to it.
 *
 * A name used twice for different shapes is thrown on rather than resolved by
 * last-write-wins: the two call sites would silently agree on whichever
 * module happened to be imported second, and the frontend would generate one
 * type for two different payloads. Input and output views of the same Zod
 * schema genuinely differ (see `openApiSchema`), so they must be given
 * different names.
 */
function registerSchema(name: string, schema: ZodType, io: 'input' | 'output'): OpenApiSchema {
  const generated = openApiSchema(schema, io);
  const existing = schemaComponents.get(name);

  if (existing && JSON.stringify(existing) !== JSON.stringify(generated)) {
    throw new Error(
      `OpenAPI component '${name}' was registered twice with different shapes. ` +
        'Give the input and output views different names.',
    );
  }

  schemaComponents.set(name, generated);
  return { $ref: `#/components/schemas/${name}` };
}

/** Everything registered so far. Read by `buildOpenApiDocument`. */
export const registeredSchemas = (): Record<string, OpenApiSchema> =>
  Object.fromEntries([...schemaComponents].sort(([a], [b]) => a.localeCompare(b)));

/**
 * Documents a request body from its Zod schema, under a component name.
 *
 * The name is required, not optional. An optional name is an invitation to
 * leave one endpoint inlined, and one unnamed response is enough to send the
 * frontend back to hand-written types for that screen.
 */
export const ApiZodBody = (name: string, schema: ZodType) =>
  applyDecorators(ApiBody({ schema: registerSchema(name, schema, 'input') }));

/** Documents a 200 response from its Zod schema, under a component name. */
export const ApiZodOk = (name: string, schema: ZodType, description?: string) =>
  applyDecorators(
    ApiOkResponse({
      schema: registerSchema(name, schema, 'output'),
      ...(description ? { description } : {}),
    }),
  );

/** Documents any status from its Zod schema, under a component name. */
export const ApiZodResponse = (
  status: number,
  name: string,
  schema: ZodType,
  description?: string,
) =>
  applyDecorators(
    ApiResponse({
      status,
      schema: registerSchema(name, schema, 'output'),
      ...(description ? { description } : {}),
    }),
  );

/**
 * Documents query parameters from a Zod object, one `ApiQuery` per key, so
 * the generated client gets real parameter names rather than an opaque blob.
 */
export function ApiZodQuery(schema: ZodObject) {
  const json = openApiSchema(schema, 'input') as {
    properties?: Record<string, OpenApiSchema>;
    required?: string[];
  };
  const required = new Set(json.required ?? []);

  return applyDecorators(
    ...Object.entries(json.properties ?? {}).map(([name, property]) =>
      ApiQuery({ name, required: required.has(name), schema: property as never }),
    ),
  );
}
