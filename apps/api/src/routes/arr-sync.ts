/**
 * ARR Sync Routes - Custom Formats & TRaSH Guides Sync API
 */

import type { FastifyInstance } from "fastify";
import {
	ArrSyncSettingsSchema,
	PreviewRequestSchema,
	ApplyRequestSchema,
	TestConnectionRequestSchema,
	type GetSettingsResponse,
	type PreviewResponse,
	type ApplyResponse,
	type TestConnectionResponse,
} from "@arr/shared";
import {
	previewSync,
	applySync,
	testConnection,
} from "../lib/arr-sync/sync-orchestrator.js";

export async function arrSyncRoutes(app: FastifyInstance) {
	// ========================================================================
	// Get Settings
	// ========================================================================

	app.get("/api/arr-sync/settings", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		try {
			// Get all Sonarr/Radarr instances with their sync settings
			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					service: {
						in: ["SONARR", "RADARR"],
					},
				},
				include: {
					arrSyncSettings: true,
				},
				orderBy: {
					label: "asc",
				},
			});

			const response: GetSettingsResponse = {
				settings: instances.map((instance) => {
					const settings = instance.arrSyncSettings;

					// Parse presets and overrides
					const parsedSettings = settings
						? {
								enabled: settings.enabled,
								trashRef: settings.trashRef,
								presets: settings.presets
									? JSON.parse(settings.presets)
									: [],
								overrides: settings.overridesJson
									? JSON.parse(settings.overridesJson)
									: {
											customFormats: {},
											scores: {},
											profiles: {},
										},
							}
						: null;

					return {
						instanceId: instance.id,
						instanceLabel: instance.label,
						instanceService: instance.service,
						settings: parsedSettings,
					};
				}),
			};

			return reply.send(response);
		} catch (error) {
			app.log.error("Failed to get ARR sync settings:", error);
			return reply.code(500).send({
				error: "Failed to get settings",
				details:
					error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Upsert Settings
	// ========================================================================

	app.put("/api/arr-sync/settings/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const { instanceId } = request.params as { instanceId: string };

		// Validate request body
		const validation = ArrSyncSettingsSchema.safeParse(request.body);
		if (!validation.success) {
			app.log.error({
				instanceId,
				requestBody: request.body,
				validationErrors: validation.error.errors,
			}, "ARR Sync settings validation failed");
			return reply.code(400).send({
				error: "Invalid settings",
				details: validation.error.errors,
			});
		}

		const settings = validation.data;

		try {
			// Check instance exists and is Sonarr/Radarr
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (
				instance.service !== "SONARR" &&
				instance.service !== "RADARR"
			) {
				return reply.code(400).send({
					error: `Instance service ${instance.service} is not supported`,
				});
			}

			// Upsert settings
			const updated = await app.prisma.arrSyncSettings.upsert({
				where: { serviceInstanceId: instanceId },
				create: {
					serviceInstanceId: instanceId,
					enabled: settings.enabled,
					trashRef: settings.trashRef,
					presets: JSON.stringify(settings.presets),
					overridesJson: JSON.stringify(settings.overrides),
				},
				update: {
					enabled: settings.enabled,
					trashRef: settings.trashRef,
					presets: JSON.stringify(settings.presets),
					overridesJson: JSON.stringify(settings.overrides),
				},
			});

			return reply.send({
				success: true,
				settings: updated,
			});
		} catch (error) {
			app.log.error("Failed to update ARR sync settings:", error);
			return reply.code(500).send({
				error: "Failed to update settings",
				details:
					error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Preview Sync (Dry Run)
	// ========================================================================

	app.post("/api/arr-sync/preview", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = PreviewRequestSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request",
				details: validation.error.errors,
			});
		}

		const { instanceIds } = validation.data;

		try {
			// Get instances to preview
			let instances;
			if (instanceIds && instanceIds.length > 0) {
				instances = await app.prisma.serviceInstance.findMany({
					where: {
						id: { in: instanceIds },
						service: { in: ["SONARR", "RADARR"] },
					},
					include: { arrSyncSettings: true },
				});
			} else {
				// Preview all configured instances
				instances = await app.prisma.serviceInstance.findMany({
					where: {
						service: { in: ["SONARR", "RADARR"] },
						arrSyncSettings: {
							enabled: true,
						},
					},
					include: { arrSyncSettings: true },
				});
			}

			// Generate preview for each instance
			const plans = await Promise.all(
				instances.map((instance) => previewSync(app, instance.id)),
			);

			const response: PreviewResponse = {
				plans,
				timestamp: new Date().toISOString(),
			};

			return reply.send(response);
		} catch (error) {
			app.log.error({
				error,
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			}, "Failed to preview sync");
			return reply.code(500).send({
				error: "Failed to preview sync",
				details:
					error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Apply Sync
	// ========================================================================

	app.post("/api/arr-sync/apply", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = ApplyRequestSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request",
				details: validation.error.errors,
			});
		}

		const { instanceIds, dryRun } = validation.data;

		try {
			// Get instances to apply to
			let instances;
			if (instanceIds && instanceIds.length > 0) {
				instances = await app.prisma.serviceInstance.findMany({
					where: {
						id: { in: instanceIds },
						service: { in: ["SONARR", "RADARR"] },
					},
					include: { arrSyncSettings: true },
				});
			} else {
				// Apply to all configured instances
				instances = await app.prisma.serviceInstance.findMany({
					where: {
						service: { in: ["SONARR", "RADARR"] },
						arrSyncSettings: {
							enabled: true,
						},
					},
					include: { arrSyncSettings: true },
				});
			}

			// Apply sync for each instance
			const startTime = Date.now();
			const results = await Promise.all(
				instances.map((instance) =>
					applySync(app, instance.id, { dryRun }),
				),
			);

			const response: ApplyResponse = {
				results,
				timestamp: new Date().toISOString(),
				totalDuration: Date.now() - startTime,
			};

			return reply.send(response);
		} catch (error) {
			app.log.error("Failed to apply sync:", error);
			return reply.code(500).send({
				error: "Failed to apply sync",
				details:
					error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Test Connection
	// ========================================================================

	app.post("/api/arr-sync/test/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const { instanceId } = request.params as { instanceId: string };

		try {
			const result = await testConnection(app, instanceId);

			const response: TestConnectionResponse = result;

			return reply.send(response);
		} catch (error) {
			app.log.error("Failed to test connection:", error);
			return reply.code(500).send({
				error: "Failed to test connection",
				details:
					error instanceof Error ? error.message : String(error),
			});
		}
	});
}
