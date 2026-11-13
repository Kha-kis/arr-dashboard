import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { ImportOperationScheduler } from "../lib/arr/import-operations/scheduler.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		importOperationScheduler: ImportOperationScheduler;
	}
}

const importOperationSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		const scheduler = new ImportOperationScheduler(
			{
				prisma: app.prisma,
				encryptor: app.encryptor,
				createClient: (instance, options) => {
					if (
						instance.service !== "SONARR" &&
						instance.service !== "RADARR" &&
						instance.service !== "LIDARR" &&
						instance.service !== "READARR"
					)
						throw new Error("Import provider is unavailable");
					return app.arrClientFactory.create({ ...instance, service: instance.service }, options);
				},
			},
			app.log,
			{ trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.arrImportObservation, fn) },
		);
		app.decorate("importOperationScheduler", scheduler);
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.arrImportObservation,
				"import observation",
				async () => {
					scheduler.start();
				},
			);
		});
		app.addHook("onClose", async () => {
			await scheduler.stop();
		});
	},
	{
		name: "import-operation-scheduler",
		dependencies: ["prisma", "security", "arr-client", "scheduler-registry"],
	},
);

export default importOperationSchedulerPlugin;
