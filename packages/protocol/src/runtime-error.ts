import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Safe-to-wire runtime failure metadata for lifecycle consumers.
 *
 * This payload must never contain stack traces, causes, credentials, user
 * content, or other secrets. Codes are stable machine identifiers; T10b owns
 * the first concrete lifecycle code catalog.
 */
export const RuntimeErrorDataV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_048),
    retryable: z.boolean(),
    details: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();

export type RuntimeErrorDataV1 = z.infer<typeof RuntimeErrorDataV1Schema>;
