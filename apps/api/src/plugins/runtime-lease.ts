import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { RuntimeLeaseManager } from "../lib/runtime-lease/runtime-lease.js";

declare module "fastify" {
	interface FastifyInstance {
		runtimeLease?: RuntimeLeaseManager;
	}
}

const runtimeLeasePlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		if (app.config.NODE_ENV !== "production") return;

		const runtimeLease = new RuntimeLeaseManager(app.prisma, app.log);
		await runtimeLease.acquire();
		app.decorate("runtimeLease", runtimeLease);
		app.log.info("Exclusive API runtime lease acquired");

		runtimeLease.start(async (error) => {
			app.log.fatal({ err: error }, "Exclusive API runtime lease lost; shutting down");
			await app.close();
		});

		app.addHook("onClose", async () => {
			try {
				await runtimeLease.release();
			} catch (error) {
				app.log.warn({ err: error }, "Failed to release runtime lease during shutdown");
			}
		});
	},
	{
		name: "runtime-lease",
		dependencies: ["prisma"],
	},
);

export default runtimeLeasePlugin;
