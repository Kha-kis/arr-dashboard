import type { FastifyPluginCallback } from "fastify";

export const registerHealthRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/", { logLevel: "silent" }, async (request, reply) => {
		try {
			await app.prisma.$queryRaw`SELECT 1`;
			return { status: "ok" };
		} catch (error) {
			request.log.error({ err: error }, "Health check failed");
			return reply.status(503).send({ status: "error", reason: "Database unavailable" });
		}
	});
	done();
};
