import { z } from "zod";
import {
  CatalogDisplayStringSchema,
  PROTOCOL_LIMITS_V1,
  RoleSchema,
  RuntimeIdentifierSchema,
} from "./domain.ts";

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const finite = z.number().finite();
const boundedPath = z
  .string()
  .max(PROTOCOL_LIMITS_V1.pathChars)
  .refine((value) => !value.includes("\0"));

export const ProjectSessionSummarySchema = loose({
  id: RuntimeIdentifierSchema,
  title: z.string(),
  model: z.string(),
  mode: z.enum(["plan", "execute"]),
  goal: z.string().nullable(),
  createdAt: finite,
  updatedAt: finite,
  latestTurnId: RuntimeIdentifierSchema.optional(),
  parentSessionId: RuntimeIdentifierSchema.optional(),
  forkedAtTurnId: RuntimeIdentifierSchema.optional(),
});
export type ProjectSessionSummary = z.infer<typeof ProjectSessionSummarySchema>;

export const SessionSearchHitSchema = loose({
  cwd: boundedPath,
  sessionId: RuntimeIdentifierSchema,
  role: RoleSchema,
  timestamp: finite,
  snippet: z.string().max(PROTOCOL_LIMITS_V1.searchSnippetChars),
  score: finite,
});
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;

export const ProjectSummarySchema = loose({
  cwd: boundedPath,
  name: CatalogDisplayStringSchema,
  updatedAt: finite,
  sessions: z.array(ProjectSessionSummarySchema),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
