import assert from "node:assert/strict";
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import lifecyclePlugin from "../../../../plugins/lifecycle.js";
import { registerSystemRoutes } from "../../../../routes/system.js";

const emit = (event) => writeSync(1, `${JSON.stringify({ event, pid: process.pid })}\n`);

export function buildServer({ env, restoreRuntime }) {
	const root = process.env.TEST_RESTART_ACTION_DIR;
	assert(root, "Synthetic restart control directory is required");
	let initial = false;
	try {
		writeFileSync(join(root, "initial-child"), "", { flag: "wx", mode: 0o600 });
		initial = true;
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	const app = Fastify({ logger: false });
	app.decorate("config", env);
	app.decorate("restoreRuntime", restoreRuntime);
	app.decorate("notificationService", { notify: async () => {} });
	// This requester is synthetic. Real authentication and rate limiting are outside this test.
	app.decorateRequest("currentUser", null);
	app.addHook("onRequest", async (request) => {
		request.currentUser = { id: "synthetic-requester", username: "synthetic" };
	});
	app.register(lifecyclePlugin);
	app.register(registerSystemRoutes, { prefix: "/api/system" });
	let requested = false;
	// No socket is opened; this real interval also keeps a ready child alive.
	const control = setInterval(() => {
		if (initial && !requested && existsSync(join(root, "request-restart"))) {
			requested = true;
			void app.inject({ method: "POST", url: "/api/system/restart" }).then((response) => {
				assert.equal(response.statusCode, 200);
				assert.deepEqual(response.json(), {
					success: true,
					message: "The application will restart automatically in a few seconds...",
				});
				emit("acknowledged");
			});
		}
	}, 10);
	app.addHook("onClose", async () => {
		emit("close-entered");
		const gate = join(root, initial ? "release-initial-close" : "release-replacement-close");
		while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10));
		emit("close-released");
		clearInterval(control);
	});
	// Replace socket I/O only. Fastify registration, injection and close remain real.
	app.listen = async () => {
		await app.ready();
		emit("ready");
	};
	return app;
}
