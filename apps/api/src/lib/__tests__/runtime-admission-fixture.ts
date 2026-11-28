import type { FastifyInstance } from "fastify";

/**
 * For isolated lifecycle/scheduler tests whose persistence is already synthetic.
 * This object is not module-branded: it cannot construct a native client or
 * grant real database admission. Native ownership is tested separately.
 */
export function installNonDatabaseRuntimeFixture(app: FastifyInstance): void {
	const run = async <T>(operation: () => T | Promise<T>): Promise<T> => await operation();
	app.decorate(
		"restoreRuntime",
		Object.freeze({
			runStarting: run,
			runOperation: run,
			runIndependentOperation: run,
			bindDestination: async () => {},
			activate: async () => {},
			closeAdmission: () => {},
			drain: async () => {},
			close: async () => {},
		}),
	);
}
