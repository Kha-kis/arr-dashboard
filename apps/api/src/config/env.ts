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
		APP_URL: z.string().url().default("http://localhost:3000"),
		TMDB_BASE_URL: z.string().url().default("https://api.themoviedb.org/3"),
		TMDB_IMAGE_BASE_URL: z.string().url().default("https://image.tmdb.org/t/p"),
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
