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

/** Documents a request body from its Zod schema. */
export const ApiZodBody = (schema: ZodType) =>
  applyDecorators(ApiBody({ schema: openApiSchema(schema, 'input') }));

/** Documents a 200 response from its Zod schema. */
export const ApiZodOk = (schema: ZodType, description?: string) =>
  applyDecorators(
    ApiOkResponse({ schema: openApiSchema(schema), ...(description ? { description } : {}) }),
  );

/** Documents any status from its Zod schema. */
export const ApiZodResponse = (status: number, schema: ZodType, description?: string) =>
  applyDecorators(
    ApiResponse({ status, schema: openApiSchema(schema), ...(description ? { description } : {}) }),
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
