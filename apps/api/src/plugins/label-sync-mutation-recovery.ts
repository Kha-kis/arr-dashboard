import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { recoverLabelSyncMutationAttempts } from "../lib/label-sync/jellyfin-mutation-repository.js";

export type LabelSyncMutationAdmission = {
	readonly isOpen: () => boolean;
};

declare module "fastify" {
	interface FastifyInstance {
		labelSyncMutationAdmission: LabelSyncMutationAdmission;
	}
}

const labelSyncMutationRecoveryPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let open = false;
		const admission: LabelSyncMutationAdmission = Object.freeze({ isOpen: () => open });
		app.decorate("labelSyncMutationAdmission", admission);

		app.addHook("onReady", async () => {
			try {
				await recoverLabelSyncMutationAttempts(app.prisma);
				open = true;
			} catch {
				app.log.error(
					{ category: "label-sync-mutation-recovery-failed" },
					"Label sync mutation recovery failed",
				);
			}
		});
	},
	{ name: "label-sync-mutation-recovery", dependencies: ["prisma"] },
);

export default labelSyncMutationRecoveryPlugin;
