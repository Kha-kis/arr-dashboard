/**
 * Centralized logging utility using Pino
 *
 * Dual-output: stdout (for docker logs / terminal) + rotating file (for persistence).
 * File rotation is handled by pino-roll in a worker thread (no main-thread I/O).
 *
 * Usage:
 *   import { logger } from '@/lib/logger.js';
 *
 *   logger.info('User logged in', { userId: '123' });
 *   logger.warn('Rate limit approaching', { remaining: 10 });
 *   logger.error('Failed to connect', { error, service: 'radarr' });
 *
 * Child loggers for modules:
 *   const log = logger.child({ module: 'hunting' });
 *   log.info('Hunt started', { instanceId: 'abc' });
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

/** Resolve the log directory — Docker uses /config/logs, dev uses ./logs */
function resolveLogDir(): string {
	if (process.env.LOG_DIR) return process.env.LOG_DIR;
	const isDocker = !isDev || process.cwd().startsWith("/app");
	return isDocker ? "/config/logs" : "./logs";
}

const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace"]);
const rawLevel = process.env.LOG_LEVEL?.toLowerCase();
export const LOG_LEVEL =
	rawLevel && VALID_LEVELS.has(rawLevel) ? rawLevel : isDev ? "debug" : "info";
export const LOG_DIR = resolveLogDir();
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || "10m";
export const LOG_MAX_FILES = Number(process.env.LOG_MAX_FILES) || 10;

// Ensure log directory exists before creating the transport
try {
	if (!existsSync(LOG_DIR)) {
		mkdirSync(LOG_DIR, { recursive: true });
	}
} catch {
	// If we can't create the directory, file logging will be skipped below
}

const logFilePath = join(LOG_DIR, "arr-dashboard.log");

/**
 * Build the log destination.
 *
 * stdout is written synchronously via pino.destination(1) (main thread) so that
 * output is always visible in `docker logs` — even when the process is backgrounded
 * by the Docker entrypoint script. A pino.transport() worker thread's fd 1 can
 * become detached from the container's stdout pipe in that scenario.
 *
 * File logging (pino-roll) runs in a worker thread via pino.transport() for
 * non-blocking I/O. Both streams are combined via pino.multistream().
 */
function buildDestination() {
	const stdout = pino.destination({ dest: 1, sync: false });
	const streams: pino.StreamEntry[] = [{ stream: stdout }];

	if (existsSync(LOG_DIR)) {
		const fileTransport = pino.transport({
			target: "pino-roll",
			options: {
				file: logFilePath,
				size: LOG_MAX_SIZE,
				limit: { count: LOG_MAX_FILES },
				mkdir: true,
			},
		});
		streams.push({ stream: fileTransport });
	}

	return pino.multistream(streams);
}

/**
 * Paths to redact from log output as a safety net.
 * If someone accidentally logs an object containing these fields,
 * Pino replaces the value with "[Redacted]" before serialization.
 */
const REDACT_PATHS = [
	"password",
	"hashedPassword",
	"apiKey",
	"access_token",
	"refresh_token",
	"id_token",
	"token",
	"clientSecret",
	"encryptedApiKey",
	"encryptionIv",
	"cookie",
	"authorization",
	// Nested paths (e.g., from req.headers or response objects)
	"req.headers.cookie",
	"req.headers.authorization",
	"tokenResponse.access_token",
	"tokenResponse.refresh_token",
	"tokenResponse.id_token",
];

/**
 * Create the base logger with stdout (main thread) + rotating file (worker thread)
 */
export const logger = pino(
	{
		level: LOG_LEVEL,
		formatters: {
			level: (label) => ({ level: label }),
		},
		timestamp: pino.stdTimeFunctions.isoTime,
		redact: {
			paths: REDACT_PATHS,
			censor: "[Redacted]",
		},
	},
	buildDestination(),
);

/**
 * Pre-configured child loggers for major modules
 * These provide consistent module tagging in log output
 */
export const loggers = {
	api: logger.child({ module: "api" }),
	auth: logger.child({ module: "auth" }),
	backup: logger.child({ module: "backup" }),
	hunting: logger.child({ module: "hunting" }),
	trashGuides: logger.child({ module: "trash-guides" }),
	deployment: logger.child({ module: "deployment" }),
	scheduler: logger.child({ module: "scheduler" }),
	queueCleaner: logger.child({ module: "queue-cleaner" }),
};

/**
 * Create a child logger for a specific module
 */
export function createLogger(module: string) {
	return logger.child({ module });
}

export default logger;
