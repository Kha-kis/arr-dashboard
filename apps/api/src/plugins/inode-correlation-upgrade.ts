import fp from "fastify-plugin";
import { retireLegacyInodeCorrelations } from "../lib/library-sync/inode-correlation-upgrade.js";

export default fp(
	async (app) => {
		app.addHook("onReady", async () => {
			try {
				const retired = await retireLegacyInodeCorrelations(app.prisma);
				app.log.info(retired, "Retired legacy inode correlations for revalidation");
			} catch {
				app.log.error(
					{ category: "inode-correlation-upgrade-failed" },
					"Legacy inode correlation upgrade failed",
				);
				throw new Error("Legacy inode correlation upgrade failed");
			}
		});
	},
	{ name: "inode-correlation-upgrade", dependencies: ["prisma"] },
);
