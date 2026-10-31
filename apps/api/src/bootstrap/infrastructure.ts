import type { FastifyInstance } from "fastify";
import { registerRestoreBootstrapPlugin } from "../lib/backup/restore-runtime-bootstrap.js";

import { arrClientPlugin } from "../plugins/arr-client.js";
import deploymentExecutorPlugin from "../plugins/deployment-executor.js";
import heapMonitorPlugin from "../plugins/heap-monitor.js";
import httpAuthMigrationPlugin from "../plugins/http-auth-migration.js";
import inodeCorrelationUpgradePlugin from "../plugins/inode-correlation-upgrade.js";
import inodeIndexHydrationPlugin from "../plugins/inode-index-hydration.js";
import labelSyncMutationRecoveryPlugin from "../plugins/label-sync-mutation-recovery.js";
import lifecyclePlugin from "../plugins/lifecycle.js";
import notificationServicePlugin from "../plugins/notification-service.js";
import { prismaPlugin } from "../plugins/prisma.js";
import providerCacheAttemptRecoveryPlugin from "../plugins/provider-cache-attempt-recovery.js";
import providerObservationRunRecoveryPlugin from "../plugins/provider-observation-run-recovery.js";
import schedulerRegistryPlugin from "../plugins/scheduler-registry.js";
import searchGrabRecoveryPlugin from "../plugins/search-grab-recovery.js";
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
 *  - labelSyncMutationRecovery → closed-by-default mutation admission latch
 *  - security          → `app.encryptor`, `app.sessionService`
 *  - arrClient         → `createInstanceFetcher` helpers for ARR services
 *  - httpAuthMigration → encrypts legacy URL-embedded proxy credentials
 *  - seerr circuit     → request breaker for Seerr outbound calls
 *  - seerr cache       → shared response cache for Seerr requests
 *  - deploymentExecutor→ `app.deploymentExecutor`
 *  - notificationService → `app.notificationService`
 *  - schedulerRegistry → `app.schedulerRegistry` (must precede scheduler plugins)
 *  - lifecycle         → graceful shutdown + health wiring
 *  - inodeIndexHydration→ owned background snapshot warm-up after inode upgrade
 *  - heapMonitor       → periodic process.memoryUsage() samples (issue #427 follow-up)
 */
export function registerInfrastructure(app: FastifyInstance): void {
	app.register(prismaPlugin);
	registerRestoreBootstrapPlugin(app, inodeCorrelationUpgradePlugin);
	registerRestoreBootstrapPlugin(app, labelSyncMutationRecoveryPlugin);
	registerRestoreBootstrapPlugin(app, providerCacheAttemptRecoveryPlugin);
	registerRestoreBootstrapPlugin(app, securityPlugin);
	registerRestoreBootstrapPlugin(app, searchGrabRecoveryPlugin);
	registerRestoreBootstrapPlugin(app, providerObservationRunRecoveryPlugin);
	registerRestoreBootstrapPlugin(app, httpAuthMigrationPlugin);
	registerRestoreBootstrapPlugin(app, arrClientPlugin);
	registerRestoreBootstrapPlugin(app, seerrCircuitBreakerPlugin);
	registerRestoreBootstrapPlugin(app, seerrCachePlugin);
	registerRestoreBootstrapPlugin(app, deploymentExecutorPlugin);
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
	registerRestoreBootstrapPlugin(app, lifecyclePlugin);
	registerRestoreBootstrapPlugin(app, inodeIndexHydrationPlugin);
	registerRestoreBootstrapPlugin(app, heapMonitorPlugin);
}
