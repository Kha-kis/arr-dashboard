/**
 * Tautulli migration boot hook (Bucket A2, ADR-0007).
 *
 * Runs the one semantic stored-rule migration of 3.0 (the Tautulli
 * rules pass) once Prisma is ready. The pass is idempotent and exits
 * without side effects when there is nothing to migrate, so running it
 * on every boot is free after the first.
 *
 * Deliberately NOT a scheduler — it is a one-shot startup task, so it
 * does not register with the SchedulerRegistry. A failure is logged
 * loudly but does not crash the boot: the rules it would migrate are
 * already inert in 3.0 (their evaluators are gone), so a failed pass
 * degrades to "disclosure unavailable," not data corruption.
 */

import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { runTautulliRulesPass } from "../lib/rules-migration/tautulli-pass.js";
import { resolveSecretsPath } from "../lib/utils/secrets-path.js";

const tautulliMigrationPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			const databaseUrl = app.config.DATABASE_URL || "file:./dev.db";
			const dataDir = path.dirname(resolveSecretsPath(databaseUrl));
			try {
				await runTautulliRulesPass(app.prisma, dataDir, app.log);
			} catch (error) {
				// The pass writes its report BEFORE the transactions, so a
				// failure here may leave rules partially migrated — never
				// claim "unchanged". The pass is idempotent and re-runs on
				// the next boot to complete the remainder.
				app.log.error(
					{ err: error, dataDir },
					"Tautulli rules pass failed — rules may be partially migrated; originals are backed up under rules-pre-3.0/ and the pass re-runs next boot",
				);
			}
		});
	},
	{ name: "tautulli-migration" },
);

export default tautulliMigrationPlugin;
