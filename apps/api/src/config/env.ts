import { z } from "zod";
import { parseBooleanEnv } from "../lib/config/port-config.js";

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

export const envSchema = z
	.object({
		NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
		API_HOST: z.string().default("0.0.0.0"),
		API_PORT: z.coerce.number().min(0).max(65535).default(3001),
		API_CORS_ORIGIN: corsOriginSchema,
		API_RATE_LIMIT_MAX: z.coerce.number().min(1).default(200),
		API_RATE_LIMIT_WINDOW: z.union([z.string(), z.coerce.number()]).default("1 minute"),
		DATABASE_URL: z.string().optional(),
		// Optional - will be auto-generated if not provided
		ENCRYPTION_KEY: z.string().min(32).optional(),
		SESSION_COOKIE_SECRET: z.string().min(32).optional(),
		SESSION_COOKIE_NAME: z.string().default("arr_session"),
		SESSION_TTL_HOURS: z.coerce
			.number()
			.min(1)
			.max(24 * 30)
			.default(24),
		PASSWORD_POLICY: z.enum(["strict", "relaxed"]).default("strict"),
		// Proxy — set to true when running behind a reverse proxy (nginx, Traefik, Caddy, etc.)
		// Enables trustProxy on Fastify so X-Forwarded-For/Proto/Host headers are trusted.
		// Also auto-enables secure cookies (HTTPS) unless COOKIE_SECURE is explicitly set.
		TRUST_PROXY: z
			.string()
			.default("false")
			.transform((v) => parseBooleanEnv(v) ?? false),
		// Cookie — override secure flag. When omitted, auto-detects from TRUST_PROXY.
		COOKIE_SECURE: z
			.string()
			.optional()
			.transform((v) => parseBooleanEnv(v)),
		APP_URL: z.string().url().default("http://localhost:3000"),
		TMDB_BASE_URL: z.string().url().default("https://api.themoviedb.org/3"),
		TMDB_IMAGE_BASE_URL: z.string().url().default("https://image.tmdb.org/t/p"),
		// Logging — these are informational in the schema; the logger reads them at
		// module load time before Zod validation runs (same pattern as LOG_LEVEL).
		LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
		LOG_DIR: z.string().optional(),
		LOG_MAX_SIZE: z.string().optional(),
		LOG_MAX_FILES: z.coerce.number().min(1).optional(),
	})
	.transform((data) => {
		// Auto-configure DATABASE_URL if not provided
		// Use /app/data/prod.db for Docker, ./dev.db for local development
		if (!data.DATABASE_URL) {
			// Detect Docker environment by checking if /app directory exists
			const isDocker = data.NODE_ENV === "production" || process.cwd().startsWith("/app");
			data.DATABASE_URL = isDocker ? "file:/app/data/prod.db" : "file:./dev.db";
		}
		return data;
	});

export type ApiEnv = z.infer<typeof envSchema>;
