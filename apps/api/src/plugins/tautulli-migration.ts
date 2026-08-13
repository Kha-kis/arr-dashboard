/**
 * Legacy Tautulli migration plugin.
 *
 * ADR-0009 preserves configured Tautulli services and Tautulli-backed rules.
 * The historical pass report remains available through the observation-only
 * reader in `rules-migration/tautulli-pass`, but startup never transforms
 * rules, writes reports, or acknowledges a notice.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";

const tautulliMigrationPlugin = fastifyPlugin(async (_app: FastifyInstance) => {}, {
	name: "tautulli-migration",
});

export default tautulliMigrationPlugin;
