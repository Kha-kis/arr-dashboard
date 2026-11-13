import { performance } from "node:perf_hooks";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { getAppVersionInfo } from "../lib/utils/version.js";

const versionInfo = getAppVersionInfo();

declare module "fastify" {
	interface FastifyContextConfig {
		/** Trusted route declaration for the public database-independent live probe. */
		runtimeLiveness?: boolean;
	}
}

export const registerHealthRoutes: FastifyPluginCallback = (app, _opts, done) => {
	type Phase = "pre-handler" | "handler-admission" | "database-check";
	const probes = new WeakMap<FastifyRequest, { phase: Phase; startedAt: number }>();
	app.addHook("onRequest", async (request) => {
		probes.set(request, { phase: "pre-handler", startedAt: performance.now() });
	});
	app.addHook("preHandler", async (request) => {
		const probe = probes.get(request);
		if (probe) probe.phase = "handler-admission";
	});
	app.addHook("onResponse", async (request, reply) => {
		const probe = probes.get(request);
		probes.delete(request);
		if (reply.statusCode < 500) return;
		// Request logging stays silent. Emit only the last boundary reached,
		// never the error, URL, headers, session or database contents.
		app.log.warn(
			{
				category: "readiness-failure",
				phase: probe?.phase ?? "unknown-request",
				statusCode: reply.statusCode,
				...(probe && { elapsedMs: Math.max(0, Math.round(performance.now() - probe.startedAt)) }),
			},
			"Readiness probe failed",
		);
	});
	app.get("/", { logLevel: "silent" }, async (request, reply) => {
		const probe = probes.get(request);
		if (probe) probe.phase = "database-check";
		try {
			await app.prisma.$queryRaw`SELECT 1`;
			return {
				status: "ok",
				version: versionInfo.version,
				commit: versionInfo.commitSha,
			};
		} catch {
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
