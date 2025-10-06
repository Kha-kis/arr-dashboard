import { libraryServiceSchema } from "@arr/shared";
import { z } from "zod";

/**
 * Validation schema for library query parameters
 */
export const libraryQuerySchema = z.object({
  service: libraryServiceSchema.optional(),
  instanceId: z.string().optional(),
});
