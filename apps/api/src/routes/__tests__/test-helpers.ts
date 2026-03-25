/**
 * Shared test infrastructure for route integration tests.
 *
 * This file contains ONLY test infrastructure helpers (auth injection,
 * error handling, encryptor mocks). Domain-specific factories (makeUser,
 * createMockPrisma, etc.) stay in each test file.
 */
import { vi } from "vitest";
import type { FastifyInstance } from "fastify";

/** Header that triggers auth injection in the preHandler hook. */
export const AUTH_HEADER = "x-test-auth";

/** Default mock user injected when AUTH_HEADER is present. */
const DEFAULT_USER = { id: "user-1", username: "admin" };

/**
 * Registers request decorations and a preHandler that injects auth context
 * when the x-test-auth header is present. Call before app.ready().
 */
export function setupAuthInjection(
	app: FastifyInstance,
	defaultUser: Record<string, unknown> = DEFAULT_USER,
) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);

	app.addHook("preHandler", async (req: any) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = defaultUser;
			req.sessionToken = "mock-session-token";
		}
	});
}

/**
 * Returns an inject helper bound to the given app that sends the auth header.
 */
export function createInjectAuthenticated(app: FastifyInstance) {
	return async (method: string, url: string, options: { body?: unknown } = {}) => {
		const injectOpts: Record<string, unknown> = {
			method,
			url,
			headers: { [AUTH_HEADER]: "1" },
		};
		if (options.body !== undefined) {
			injectOpts.payload = options.body;
		}
		return app.inject(injectOpts as any);
	};
}

/**
 * Creates a mock encryptor decoration. Override decryptReturn for tests
 * that need specific decrypted values (e.g., JSON config strings).
 */
export function createMockEncryptor(decryptReturn = "decrypted") {
	return {
		encrypt: vi.fn().mockReturnValue({ value: "encrypted", iv: "mock-iv" }),
		decrypt: vi.fn().mockReturnValue(decryptReturn),
	};
}

/**
 * Registers a lightweight error handler that matches the production
 * statusCode convention from server.ts. Handles:
 * - statusCode-convention errors (InstanceNotFoundError, etc.) → status from error
 * - ZodValidationError → 400
 * - Everything else → 500
 */
export function registerTestErrorHandler(app: FastifyInstance) {
	app.setErrorHandler((error: any, _request, reply) => {
		if (error.statusCode && typeof error.statusCode === "number") {
			return reply.status(error.statusCode).send({
				error: error.name,
				message: error.message,
				...("details" in error ? { details: error.details } : {}),
			});
		}
		if (error.name === "ZodValidationError") {
			return reply.status(400).send({
				error: "Validation failed",
				details: error.details,
			});
		}
		return reply.status(500).send({ error: "Internal Server Error" });
	});
}
