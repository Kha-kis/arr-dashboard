import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { RuntimeLeaseManager } from "../lib/runtime-lease/runtime-lease.js";

const LEASE_SHUTDOWN_GRACE_MS = 8_000;

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
			const forceExitTimer = setTimeout(() => process.exit(1), LEASE_SHUTDOWN_GRACE_MS);
			try {
				await app.close();
			} finally {
				clearTimeout(forceExitTimer);
				// Lease loss means this process must not remain alive in any capacity.
				// Fastify cleanup runs first; an explicit non-zero exit also handles
				// optional clients that retain referenced event-loop handles.
				process.exit(1);
			}
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
