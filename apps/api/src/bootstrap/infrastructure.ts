import type { FastifyInstance } from "fastify";

import { arrClientPlugin } from "../plugins/arr-client.js";
import deploymentExecutorPlugin from "../plugins/deployment-executor.js";
import lifecyclePlugin from "../plugins/lifecycle.js";
import notificationServicePlugin from "../plugins/notification-service.js";
import { prismaPlugin } from "../plugins/prisma.js";
import { securityPlugin } from "../plugins/security.js";
import seerrCachePlugin from "../plugins/seerr-cache.js";
import seerrCircuitBreakerPlugin from "../plugins/seerr-circuit-breaker.js";

/**
 * Core infrastructure plugins — registered first because every domain depends on them.
 *
 * Order matters: each plugin below decorates `app` with state used by later
 * plugins and by route handlers. Do not reorder without reviewing decorations.
 *
 *  - prisma            → `app.prisma`
 *  - security          → `app.encryptor`, `app.sessionService`
 *  - arrClient         → `createInstanceFetcher` helpers for ARR services
 *  - seerr circuit     → request breaker for Seerr outbound calls
 *  - seerr cache       → shared response cache for Seerr requests
 *  - deploymentExecutor→ `app.deploymentExecutor`
 *  - notificationService → `app.notificationService`
 *  - lifecycle         → graceful shutdown + health wiring
 */
export function registerInfrastructure(app: FastifyInstance): void {
	app.register(prismaPlugin);
	app.register(securityPlugin);
	app.register(arrClientPlugin);
	app.register(seerrCircuitBreakerPlugin);
	app.register(seerrCachePlugin);
	app.register(deploymentExecutorPlugin);
	app.register(notificationServicePlugin);
	app.register(lifecyclePlugin);
}
