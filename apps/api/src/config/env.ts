import { z } from "zod";

const corsOriginSchema = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .or(z.array(z.string()))
  .default(["http://localhost:3000", "http://localhost:3001"]);

export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().min(0).max(65535).default(3001),
  API_CORS_ORIGIN: corsOriginSchema,
  API_RATE_LIMIT_MAX: z.coerce.number().min(1).default(200),
  API_RATE_LIMIT_WINDOW: z
    .union([z.string(), z.coerce.number()])
    .default("1 minute"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters"),
  SESSION_COOKIE_SECRET: z
    .string()
    .min(32, "SESSION_COOKIE_SECRET must be at least 32 characters"),
  SESSION_COOKIE_NAME: z.string().default("arr_session"),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .min(1)
    .max(24 * 30)
    .default(24),
  APP_URL: z.string().url().default("http://localhost:3000"),
});

export type ApiEnv = z.infer<typeof envSchema>;
