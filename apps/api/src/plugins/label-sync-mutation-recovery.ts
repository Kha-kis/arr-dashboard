import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { recoverLabelSyncMutationAttempts } from "../lib/label-sync/jellyfin-mutation-repository.js";
import {
	type LabelSyncMutationAdmission,
	registerLabelSyncMutationAdmission,
} from "../lib/label-sync/mutation-admission.js";

export type { LabelSyncMutationAdmission } from "../lib/label-sync/mutation-admission.js";

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
		const unregister = registerLabelSyncMutationAdmission(app.prisma, admission);
		app.addHook("onClose", async () => {
			open = false;
			unregister();
		});

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
