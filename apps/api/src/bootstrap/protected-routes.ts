import type { FastifyInstance } from "fastify";

import { registerBackupRoutes } from "../routes/backup.js";
import { registerDashboardRoutes } from "../routes/dashboard.js";
import { registerHuntingRoutes } from "../routes/hunting.js";
import { registerJellyfinRoutes } from "../routes/jellyfin/index.js";
import { registerLibraryRoutes } from "../routes/library.js";
import { registerLibraryCleanupRoutes } from "../routes/library-cleanup.js";
import { registerManualImportRoutes } from "../routes/manual-import.js";
import { registerNotificationRoutes } from "../routes/notifications.js";
import oidcProvidersRoutes from "../routes/oidc-providers.js";
import { registerPlexRoutes } from "../routes/plex/index.js";
import { registerPulseRoutes } from "../routes/pulse.js";
import { registerQueueCleanerRoutes } from "../routes/queue-cleaner.js";
import { registerSearchRoutes } from "../routes/search.js";
import { registerSeerrRoutes } from "../routes/seerr/index.js";
import { registerServiceRoutes } from "../routes/services.js";
import { registerSystemRoutes } from "../routes/system.js";
import { registerTautulliRoutes } from "../routes/tautulli/index.js";
import { registerTrashGuidesRoutes } from "../routes/trash-guides/index.js";

/**
 * Protected API routes — gated by the session preHandler registered here.
 *
 * The preHandler rejects any request without a populated `request.currentUser`.
 * Route groups below are organized by product domain so that ownership is
 * obvious at a glance.
 */
export function registerProtectedRoutes(app: FastifyInstance): void {
	app.register(async (api) => {
		api.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser?.id) {
				return reply.status(401).send({ error: "Authentication required" });
			}
		});

		// --- Auth / identity management ---
		api.register(oidcProvidersRoutes);

		// --- System + operator surface ---
		api.register(registerSystemRoutes, { prefix: "/api/system" });
		api.register(registerBackupRoutes, { prefix: "/api/backup" });
		api.register(registerNotificationRoutes, { prefix: "/api/notifications" });

		// --- ARR services (Sonarr / Radarr / Prowlarr / Lidarr / Readarr) ---
		api.register(registerServiceRoutes, { prefix: "/api" });
		api.register(registerDashboardRoutes, { prefix: "/api" });
		api.register(registerLibraryRoutes, { prefix: "/api" });
		api.register(registerSearchRoutes, { prefix: "/api" });
		api.register(registerManualImportRoutes, { prefix: "/api" });

		// --- ARR automation ---
		api.register(registerHuntingRoutes, { prefix: "/api" });
		api.register(registerQueueCleanerRoutes, { prefix: "/api" });
		api.register(registerLibraryCleanupRoutes, { prefix: "/api" });

		// --- Media servers (Plex / Jellyfin / Tautulli) ---
		api.register(registerPlexRoutes, { prefix: "/api/plex" });
		api.register(registerJellyfinRoutes, { prefix: "/api/jellyfin" });
		api.register(registerTautulliRoutes, { prefix: "/api/tautulli" });
		api.register(registerPulseRoutes, { prefix: "/api" });

		// --- External integrations (Seerr / TRaSH Guides) ---
		api.register(registerSeerrRoutes, { prefix: "/api/seerr" });
		api.register(registerTrashGuidesRoutes, { prefix: "/api/trash-guides" });
	});
}
