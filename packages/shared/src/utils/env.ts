import { z } from "zod";

type EnvInput = Record<string, string | undefined>;

/**
 * Creates a safe environment parser using Zod schemas.
 * Ensures we fail fast when mandatory env vars are missing or malformed.
 */
export const parseEnv = <TSchema extends z.ZodRawShape>(
  shape: TSchema,
  input: EnvInput = process.env,
): z.infer<z.ZodObject<TSchema>> => {
  const schema = z.object(shape);
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    const formatted = parsed.error.format();
    const missing = Object.entries(formatted)
      .filter(([key]) => key !== "_errors")
      .map(([key, value]) => {
        const errors = (value as any)?._errors ?? [];
        const message = errors.length > 0 ? errors.join(", ") : "invalid";
        return key + ": " + message;
      });

    throw new Error(
      "Invalid environment configuration:\n" + missing.join("\n"),
    );
  }

  return parsed.data;
};
