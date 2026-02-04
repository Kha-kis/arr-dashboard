/**
 * Centralized logging utility using Pino
 *
 * Provides structured logging with proper log levels and context.
 * Use this instead of console.log/warn/error throughout the codebase.
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

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Create the base logger with appropriate configuration
 *
 * In development: Human-readable output with timestamps
 * In production: JSON output for log aggregation
 */
export const logger = pino({
	level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
	formatters: {
		level: (label) => ({ level: label }),
	},
	timestamp: pino.stdTimeFunctions.isoTime,
});

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
