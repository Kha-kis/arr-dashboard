import type { FastifyInstance } from "fastify";
import { registerRestoreBootstrapPlugin } from "../../lib/backup/restore-runtime-bootstrap.js";
import { arrClientPlugin } from "../../plugins/arr-client.js";
import lifecyclePlugin from "../../plugins/lifecycle.js";
import { prismaPlugin } from "../../plugins/prisma.js";
import { securityPlugin } from "../../plugins/security.js";

/** Real native SQL, session and bootstrap admission; no unrelated schedulers. */
export function registerNativeProtectedInfrastructure(app: FastifyInstance): void {
	app.register(prismaPlugin);
	registerRestoreBootstrapPlugin(app, securityPlugin);
	registerRestoreBootstrapPlugin(app, arrClientPlugin);
	registerRestoreBootstrapPlugin(app, lifecyclePlugin);
}
