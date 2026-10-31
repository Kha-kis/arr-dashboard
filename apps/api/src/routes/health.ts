import type { FastifyPluginCallback } from "fastify";
import { getAppVersionInfo } from "../lib/utils/version.js";

const versionInfo = getAppVersionInfo();

declare module "fastify" {
	interface FastifyContextConfig {
		/** Trusted route declaration for the public database-independent live probe. */
		runtimeLiveness?: boolean;
	}
}

export const registerHealthRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/", { logLevel: "silent" }, async (request, reply) => {
		try {
			await app.prisma.$queryRaw`SELECT 1`;
			return {
				status: "ok",
				version: versionInfo.version,
				commit: versionInfo.commitSha,
			};
		} catch (error) {
			request.log.error({ err: error }, "Health check failed");
			return reply.status(503).send({
				status: "error",
				version: versionInfo.version,
				commit: versionInfo.commitSha,
				reason: "Database unavailable",
			});
		}
	});
	done();
};

export const registerLiveRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/", { logLevel: "silent", config: { runtimeLiveness: true } }, async () => ({
		status: "ok",
	}));
	done();
};
