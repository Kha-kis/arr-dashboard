/**
 * TRaSH Guides Routes
 * Browse and import custom formats from TRaSH Guides
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchTrashGuides, fetchCFGroups, fetchQualityProfiles } from "../lib/arr-sync/trash/trash-fetcher.js";
import type { ServiceType } from "@prisma/client";

// Request schemas
const GetTrashFormatsQuerySchema = z.object({
	service: z.enum(["SONARR", "RADARR"]),
	ref: z.string().default("master"),
});

const ImportTrashFormatSchema = z.object({
	instanceId: z.string(),
	trashId: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	ref: z.string().default("master"),
});

const ImportCFGroupSchema = z.object({
	instanceId: z.string(),
	groupFileName: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	ref: z.string().default("master"),
});

const ApplyQualityProfileSchema = z.object({
	instanceId: z.string(),
	profileFileName: z.string(),
	service: z.enum(["SONARR", "RADARR"]),
	ref: z.string().default("master"),
});

export async function trashGuidesRoutes(app: FastifyInstance) {
	// ========================================================================
	// Get TRaSH Sync Settings (Per-Instance)
	// ========================================================================

	app.get("/api/trash-guides/sync-settings", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		try {
			// Get all instance sync settings
			const settings = await app.prisma.trashInstanceSyncSettings.findMany();

			return reply.send({ settings });
		} catch (error) {
			app.log.error("Failed to get TRaSH sync settings:", error);
			return reply.code(500).send({
				error: "Failed to get sync settings",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get TRaSH Sync Settings for Single Instance
	// ========================================================================

	app.get("/api/trash-guides/sync-settings/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const paramsValidation = z.object({
			instanceId: z.string(),
		}).safeParse(request.params);

		if (!paramsValidation.success) {
			return reply.code(400).send({
				error: "Invalid instance ID",
				details: paramsValidation.error.errors,
			});
		}

		const { instanceId } = paramsValidation.data;

		try {
			// Get or return default settings
			const settings = await app.prisma.trashInstanceSyncSettings.findUnique({
				where: { serviceInstanceId: instanceId },
			});

			if (!settings) {
				// Return default settings (not saved)
				return reply.send({
					serviceInstanceId: instanceId,
					enabled: false,
					intervalType: "DISABLED",
					intervalValue: 24,
					syncFormats: true,
					syncCFGroups: true,
					syncQualityProfiles: true,
					lastRunAt: null,
					lastRunStatus: null,
					lastErrorMessage: null,
					formatsSynced: 0,
					formatsFailed: 0,
					cfGroupsSynced: 0,
					qualityProfilesSynced: 0,
					nextRunAt: null,
				});
			}

			return reply.send(settings);
		} catch (error) {
			app.log.error("Failed to get instance TRaSH sync settings:", error);
			return reply.code(500).send({
				error: "Failed to get sync settings",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Update TRaSH Sync Settings for Instance
	// ========================================================================

	app.put("/api/trash-guides/sync-settings/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const paramsValidation = z.object({
			instanceId: z.string(),
		}).safeParse(request.params);

		if (!paramsValidation.success) {
			return reply.code(400).send({
				error: "Invalid instance ID",
				details: paramsValidation.error.errors,
			});
		}

		const { instanceId } = paramsValidation.data;

		const validation = z.object({
			enabled: z.boolean(),
			intervalType: z.enum(["DISABLED", "HOURLY", "DAILY", "WEEKLY"]),
			intervalValue: z.number().int().min(1).max(168), // Max 168 hours (1 week)
			syncFormats: z.boolean().optional().default(true),
			syncCFGroups: z.boolean().optional().default(true),
			syncQualityProfiles: z.boolean().optional().default(true),
		}).safeParse(request.body);

		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { enabled, intervalType, intervalValue, syncFormats, syncCFGroups, syncQualityProfiles } = validation.data;

		try {
			// Verify instance exists
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			// Calculate next run time if enabling
			let nextRunAt: Date | null = null;
			if (enabled && intervalType !== "DISABLED") {
				const now = new Date();
				switch (intervalType) {
					case "HOURLY":
						nextRunAt = new Date(now.getTime() + intervalValue * 60 * 60 * 1000);
						break;
					case "DAILY":
						nextRunAt = new Date(now.getTime() + intervalValue * 24 * 60 * 60 * 1000);
						break;
					case "WEEKLY":
						nextRunAt = new Date(now.getTime() + 7 * intervalValue * 24 * 60 * 60 * 1000);
						break;
				}
			}

			// Update or create settings for this instance
			const settings = await app.prisma.trashInstanceSyncSettings.upsert({
				where: { serviceInstanceId: instanceId },
				update: {
					enabled,
					intervalType,
					intervalValue,
					syncFormats,
					syncCFGroups,
					syncQualityProfiles,
					nextRunAt: enabled && intervalType !== "DISABLED" ? nextRunAt : null,
				},
				create: {
					serviceInstanceId: instanceId,
					enabled,
					intervalType,
					intervalValue,
					syncFormats,
					syncCFGroups,
					syncQualityProfiles,
					nextRunAt: enabled && intervalType !== "DISABLED" ? nextRunAt : null,
				},
			});

			app.log.info(
				{
					instanceId,
					instanceLabel: instance.label,
					enabled,
					intervalType,
					intervalValue,
				},
				"TRaSH sync settings updated for instance",
			);

			return reply.send(settings);
		} catch (error) {
			app.log.error("Failed to update TRaSH sync settings:", error);
			return reply.code(500).send({
				error: "Failed to update sync settings",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get TRaSH-Managed Custom Formats Tracking Info
	// ========================================================================

	app.get("/api/trash-guides/tracked", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		try {
			const tracked = await app.prisma.trashCustomFormatTracking.findMany({
				orderBy: [
					{ serviceInstanceId: "asc" },
					{ customFormatName: "asc" },
				],
			});

			// Group by instance
			const byInstance = tracked.reduce((acc, item) => {
				if (!acc[item.serviceInstanceId]) {
					acc[item.serviceInstanceId] = [];
				}
				acc[item.serviceInstanceId].push({
					customFormatId: item.customFormatId,
					customFormatName: item.customFormatName,
					trashId: item.trashId,
					service: item.service,
					syncExcluded: item.syncExcluded,
					lastSyncedAt: item.lastSyncedAt,
					gitRef: item.gitRef,
					importSource: item.importSource,
					sourceReference: item.sourceReference,
				});
				return acc;
			}, {} as Record<string, any[]>);

			return reply.send({ tracked: byInstance });
		} catch (error) {
			app.log.error("Failed to get TRaSH tracking info:", error);
			return reply.code(500).send({
				error: "Failed to get tracking info",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Toggle Sync Exclusion for a TRaSH-Managed Custom Format
	// ========================================================================

	app.put("/api/trash-guides/tracked/:instanceId/:customFormatId/exclusion", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const paramsValidation = z.object({
			instanceId: z.string(),
			customFormatId: z.string(),
		}).safeParse(request.params);

		if (!paramsValidation.success) {
			return reply.code(400).send({
				error: "Invalid parameters",
				details: paramsValidation.error.errors,
			});
		}

		const bodyValidation = z.object({
			syncExcluded: z.boolean(),
		}).safeParse(request.body);

		if (!bodyValidation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: bodyValidation.error.errors,
			});
		}

		const { instanceId, customFormatId } = paramsValidation.data;
		const { syncExcluded } = bodyValidation.data;

		try {
			const tracking = await app.prisma.trashCustomFormatTracking.findUnique({
				where: {
					serviceInstanceId_customFormatId: {
						serviceInstanceId: instanceId,
						customFormatId: Number(customFormatId),
					},
				},
			});

			if (!tracking) {
				return reply.code(404).send({ error: "Tracking record not found" });
			}

			const updated = await app.prisma.trashCustomFormatTracking.update({
				where: {
					serviceInstanceId_customFormatId: {
						serviceInstanceId: instanceId,
						customFormatId: Number(customFormatId),
					},
				},
				data: {
					syncExcluded,
				},
			});

			app.log.info({
				instanceId,
				customFormatId,
				formatName: updated.customFormatName,
				syncExcluded,
			}, "TRaSH format sync exclusion toggled");

			return reply.send({
				message: syncExcluded
					? `Custom format "${updated.customFormatName}" excluded from sync`
					: `Custom format "${updated.customFormatName}" included in sync`,
				customFormatId: updated.customFormatId,
				customFormatName: updated.customFormatName,
				syncExcluded: updated.syncExcluded,
			});
		} catch (error) {
			app.log.error("Failed to toggle sync exclusion:", error);
			return reply.code(500).send({
				error: "Failed to toggle sync exclusion",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Available TRaSH Custom Formats
	// ========================================================================

	app.get("/api/trash-guides/formats", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const queryValidation = GetTrashFormatsQuerySchema.safeParse(request.query);
		if (!queryValidation.success) {
			return reply.code(400).send({
				error: "Invalid query parameters",
				details: queryValidation.error.errors,
			});
		}

		const { service, ref } = queryValidation.data;

		try {
			app.log.info({
				service,
				ref,
			}, "Fetching TRaSH guides custom formats");

			const trashData = await fetchTrashGuides({
				service: service as ServiceType,
				ref,
			});

			app.log.info({
				service,
				ref,
				count: trashData.customFormats.length,
			}, "TRaSH guides custom formats fetched");

			return reply.send({
				customFormats: trashData.customFormats,
				version: trashData.version,
				lastUpdated: trashData.lastUpdated,
			});
		} catch (error) {
			app.log.error("Failed to fetch TRaSH guides:", error);
			return reply.code(500).send({
				error: "Failed to fetch TRaSH guides",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Sync TRaSH Custom Formats for an Instance
	// ========================================================================

	app.post("/api/trash-guides/sync", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = z.object({
			instanceId: z.string(),
			ref: z.string().default("master"),
		}).safeParse(request.body);

		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, ref } = validation.data;

		try {
			// Get the instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			// Get all TRaSH-tracked formats for this instance
			const trackedFormats = await app.prisma.trashCustomFormatTracking.findMany({
				where: { serviceInstanceId: instanceId },
			});

			if (trackedFormats.length === 0) {
				return reply.send({
					message: "No TRaSH-managed custom formats to sync",
					synced: 0,
					failed: 0,
				});
			}

			// Fetch latest TRaSH data
			const trashData = await fetchTrashGuides({
				service: instance.service as ServiceType,
				ref,
			});

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			let syncedCount = 0;
			let failedCount = 0;
			const results = [];

			// Sync each tracked format
			for (const tracked of trackedFormats) {
				try {
					// Skip formats excluded from sync
					if (tracked.syncExcluded) {
						app.log.debug({
							customFormatId: tracked.customFormatId,
							formatName: tracked.customFormatName,
						}, "Skipping sync for excluded format");
						results.push({
							customFormatId: tracked.customFormatId,
							name: tracked.customFormatName,
							status: "skipped",
						});
						continue;
					}

					// Find the latest version from TRaSH
					const latestFormat = trashData.customFormats.find(
						(cf) => cf.trash_id === tracked.trashId
					);

					if (!latestFormat) {
						app.log.warn({
							trashId: tracked.trashId,
							formatName: tracked.customFormatName,
						}, "TRaSH format no longer exists in guides");
						failedCount++;
						results.push({
							customFormatId: tracked.customFormatId,
							name: tracked.customFormatName,
							status: "not_found",
						});
						continue;
					}

					// Update the format in Sonarr/Radarr
					const updateResponse = await fetcher(
						`/api/v3/customformat/${tracked.customFormatId}`,
						{
							method: "PUT",
							body: JSON.stringify({
								id: tracked.customFormatId,
								name: latestFormat.name,
								includeCustomFormatWhenRenaming: latestFormat.includeCustomFormatWhenRenaming,
								specifications: latestFormat.specifications,
							}),
							headers: {
								"Content-Type": "application/json",
							},
						}
					);

					if (!updateResponse.ok) {
						app.log.error({
							customFormatId: tracked.customFormatId,
							statusCode: updateResponse.status,
						}, "Failed to update custom format during sync");
						failedCount++;
						results.push({
							customFormatId: tracked.customFormatId,
							name: tracked.customFormatName,
							status: "failed",
						});
						continue;
					}

					// Update tracking record
					await app.prisma.trashCustomFormatTracking.update({
						where: {
							serviceInstanceId_customFormatId: {
								serviceInstanceId: instanceId,
								customFormatId: tracked.customFormatId,
							},
						},
						data: {
							customFormatName: latestFormat.name,
							lastSyncedAt: new Date(),
							gitRef: ref,
						},
					});

					syncedCount++;
					results.push({
						customFormatId: tracked.customFormatId,
						name: latestFormat.name,
						status: "synced",
					});
				} catch (error) {
					app.log.error({
						customFormatId: tracked.customFormatId,
						error: error instanceof Error ? error.message : String(error),
					}, "Error syncing custom format");
					failedCount++;
					results.push({
						customFormatId: tracked.customFormatId,
						name: tracked.customFormatName,
						status: "error",
					});
				}
			}

			return reply.send({
				message: `Synced ${syncedCount} custom format(s), ${failedCount} failed`,
				synced: syncedCount,
				failed: failedCount,
				results,
			});
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				instanceId,
			}, "Failed to sync TRaSH custom formats");
			return reply.code(500).send({
				error: "Failed to sync custom formats",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Import TRaSH Custom Format
	// ========================================================================

	app.post("/api/trash-guides/import", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = ImportTrashFormatSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, trashId, service, ref } = validation.data;

		try {
			// Fetch the instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (instance.service !== service) {
				return reply.code(400).send({
					error: `Instance service ${instance.service} does not match requested service ${service}`,
				});
			}

			// Fetch TRaSH guides data
			const trashData = await fetchTrashGuides({
				service: service as ServiceType,
				ref,
			});

			// Find the specific custom format
			const trashFormat = trashData.customFormats.find(
				(cf) => cf.trash_id === trashId
			);

			if (!trashFormat) {
				return reply.code(404).send({
					error: "Custom format not found in TRaSH guides",
				});
			}

			// Import the custom format using the existing custom formats route logic
			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			// Check if this custom format already exists
			const existingResponse = await fetcher("/api/v3/customformat");
			const existingFormats = await existingResponse.json();

			const existingFormat = existingFormats.find(
				(cf: any) => cf.name === trashFormat.name
			);

			let result;
			if (existingFormat) {
				// Update existing
				const updateResponse = await fetcher(
					`/api/v3/customformat/${existingFormat.id}`,
					{
						method: "PUT",
						body: JSON.stringify({
							...existingFormat,
							name: trashFormat.name,
							includeCustomFormatWhenRenaming:
								trashFormat.includeCustomFormatWhenRenaming,
							specifications: trashFormat.specifications,
						}),
						headers: {
							"Content-Type": "application/json",
						},
					}
				);

				if (!updateResponse.ok) {
					const errorText = await updateResponse.text();
					app.log.error({
						statusCode: updateResponse.status,
						statusText: updateResponse.statusText,
						errorBody: errorText,
					}, "Failed to update custom format in arr instance");
					throw new Error(`Failed to update custom format: ${updateResponse.status} ${errorText}`);
				}

				result = await updateResponse.json();

				app.log.info({
					instanceId,
					trashId,
					formatName: trashFormat.name,
				}, "TRaSH custom format updated");

				// Track this custom format as TRaSH-managed
				await app.prisma.trashCustomFormatTracking.upsert({
					where: {
						serviceInstanceId_customFormatId: {
							serviceInstanceId: instanceId,
							customFormatId: result.id,
						},
					},
					update: {
						customFormatName: trashFormat.name,
						trashId,
						lastSyncedAt: new Date(),
						gitRef: ref,
					},
					create: {
						serviceInstanceId: instanceId,
						customFormatId: result.id,
						customFormatName: trashFormat.name,
						trashId,
						service: service as any,
						gitRef: ref,
						importSource: "INDIVIDUAL",
					},
				});

				return reply.send({
					message: "Custom format updated from TRaSH guides",
					customFormat: result,
					action: "updated",
				});
			} else {
				// Create new
				const createResponse = await fetcher("/api/v3/customformat", {
					method: "POST",
					body: JSON.stringify({
						name: trashFormat.name,
						includeCustomFormatWhenRenaming:
							trashFormat.includeCustomFormatWhenRenaming,
						specifications: trashFormat.specifications,
					}),
					headers: {
						"Content-Type": "application/json",
					},
				});

				if (!createResponse.ok) {
					const errorText = await createResponse.text();
					app.log.error({
						statusCode: createResponse.status,
						statusText: createResponse.statusText,
						errorBody: errorText,
						formatName: trashFormat.name,
					}, "Failed to create custom format in arr instance");
					throw new Error(`Failed to create custom format: ${createResponse.status} ${errorText}`);
				}

				result = await createResponse.json();

				app.log.info({
					instanceId,
					trashId,
					formatName: trashFormat.name,
				}, "TRaSH custom format created");

				// Track this custom format as TRaSH-managed
				await app.prisma.trashCustomFormatTracking.create({
					data: {
						serviceInstanceId: instanceId,
						customFormatId: result.id,
						customFormatName: trashFormat.name,
						trashId,
						service: service as any,
						gitRef: ref,
						importSource: "INDIVIDUAL",
					},
				});

				return reply.send({
					message: "Custom format imported from TRaSH guides",
					customFormat: result,
					action: "created",
				});
			}
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				instanceId,
				trashId,
			}, "Failed to import TRaSH custom format");
			return reply.code(500).send({
				error: "Failed to import custom format",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Available CF Groups
	// ========================================================================

	app.get("/api/trash-guides/cf-groups", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const queryValidation = GetTrashFormatsQuerySchema.safeParse(request.query);
		if (!queryValidation.success) {
			return reply.code(400).send({
				error: "Invalid query parameters",
				details: queryValidation.error.errors,
			});
		}

		const { service, ref } = queryValidation.data;

		try {
			app.log.info({
				service,
				ref,
			}, "Fetching TRaSH guides CF groups");

			const cfGroups = await fetchCFGroups({
				service: service as ServiceType,
				ref,
			});

			app.log.info({
				service,
				ref,
				count: cfGroups.length,
			}, "TRaSH guides CF groups fetched");

			return reply.send({
				cfGroups,
				version: ref,
				lastUpdated: new Date().toISOString(),
			});
		} catch (error) {
			app.log.error("Failed to fetch TRaSH CF groups:", error);
			return reply.code(500).send({
				error: "Failed to fetch TRaSH CF groups",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Import CF Group (Multiple Custom Formats)
	// ========================================================================

	app.post("/api/trash-guides/import-cf-group", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = ImportCFGroupSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, groupFileName, service, ref } = validation.data;

		try {
			// Fetch the instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (instance.service !== service) {
				return reply.code(400).send({
					error: `Instance service ${instance.service} does not match requested service ${service}`,
				});
			}

			// Fetch CF groups data
			const cfGroups = await fetchCFGroups({
				service: service as ServiceType,
				ref,
			});

			// Find the specific CF group
			const cfGroup = cfGroups.find((group) => group.fileName === groupFileName);

			if (!cfGroup) {
				return reply.code(404).send({
					error: "CF group not found in TRaSH guides",
				});
			}

			// Fetch TRaSH custom formats to get the actual format data
			const trashData = await fetchTrashGuides({
				service: service as ServiceType,
				ref,
			});

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			let importedCount = 0;
			let failedCount = 0;
			const results = [];

			// Import each custom format in the group
			for (const cfRef of cfGroup.custom_formats || []) {
				try {
					const trashFormat = trashData.customFormats.find(
						(cf) => cf.trash_id === cfRef.trash_id
					);

					if (!trashFormat) {
						app.log.warn({
							trashId: cfRef.trash_id,
							groupName: cfGroup.name,
						}, "Custom format not found in TRaSH guides");
						failedCount++;
						results.push({
							trashId: cfRef.trash_id,
							name: cfRef.trash_id,
							status: "not_found",
						});
						continue;
					}

					// Check if this custom format already exists
					const existingResponse = await fetcher("/api/v3/customformat");
					const existingFormats = await existingResponse.json();

					const existingFormat = existingFormats.find(
						(cf: any) => cf.name === trashFormat.name
					);

					let result;
					if (existingFormat) {
						// Update existing
						const updateResponse = await fetcher(
							`/api/v3/customformat/${existingFormat.id}`,
							{
								method: "PUT",
								body: JSON.stringify({
									...existingFormat,
									name: trashFormat.name,
									includeCustomFormatWhenRenaming:
										trashFormat.includeCustomFormatWhenRenaming,
									specifications: trashFormat.specifications,
								}),
								headers: {
									"Content-Type": "application/json",
								},
							}
						);

						if (!updateResponse.ok) {
							throw new Error(`Failed to update custom format: ${updateResponse.status}`);
						}

						result = await updateResponse.json();

						// Track this custom format as TRaSH-managed
						await app.prisma.trashCustomFormatTracking.upsert({
							where: {
								serviceInstanceId_customFormatId: {
									serviceInstanceId: instanceId,
									customFormatId: result.id,
								},
							},
							update: {
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								lastSyncedAt: new Date(),
								gitRef: ref,
							},
							create: {
								serviceInstanceId: instanceId,
								customFormatId: result.id,
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								service: service as any,
								gitRef: ref,
								importSource: "CF_GROUP",
								sourceReference: groupFileName,
							},
						});
					} else {
						// Create new
						const createResponse = await fetcher("/api/v3/customformat", {
							method: "POST",
							body: JSON.stringify({
								name: trashFormat.name,
								includeCustomFormatWhenRenaming:
									trashFormat.includeCustomFormatWhenRenaming,
								specifications: trashFormat.specifications,
							}),
							headers: {
								"Content-Type": "application/json",
							},
						});

						if (!createResponse.ok) {
							throw new Error(`Failed to create custom format: ${createResponse.status}`);
						}

						result = await createResponse.json();

						// Track this custom format as TRaSH-managed
						await app.prisma.trashCustomFormatTracking.create({
							data: {
								serviceInstanceId: instanceId,
								customFormatId: result.id,
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								service: service as any,
								gitRef: ref,
								importSource: "CF_GROUP",
								sourceReference: groupFileName,
							},
						});
					}

					importedCount++;
					results.push({
						trashId: cfRef.trash_id,
						name: trashFormat.name,
						status: "imported",
					});
				} catch (error) {
					app.log.error({
						trashId: cfRef.trash_id,
						error: error instanceof Error ? error.message : String(error),
					}, "Failed to import custom format from CF group");
					failedCount++;
					results.push({
						trashId: cfRef.trash_id,
						name: cfRef.trash_id,
						status: "failed",
					});
				}
			}

			// Track this CF group import
			await app.prisma.trashCFGroupTracking.upsert({
				where: {
					serviceInstanceId_groupFileName: {
						serviceInstanceId: instanceId,
						groupFileName,
					},
				},
				update: {
					groupName: cfGroup.name,
					importedCount,
					lastSyncedAt: new Date(),
					gitRef: ref,
				},
				create: {
					serviceInstanceId: instanceId,
					groupFileName,
					groupName: cfGroup.name,
					service: service as any,
					importedCount,
					gitRef: ref,
				},
			});

			app.log.info({
				instanceId,
				groupFileName,
				groupName: cfGroup.name,
				importedCount,
				failedCount,
			}, "CF group tracked");

			return reply.send({
				message: `Imported ${importedCount} custom format(s) from group, ${failedCount} failed`,
				imported: importedCount,
				failed: failedCount,
				results,
				groupName: cfGroup.name,
			});
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				instanceId,
				groupFileName,
			}, "Failed to import CF group");
			return reply.code(500).send({
				error: "Failed to import CF group",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Available Quality Profiles
	// ========================================================================

	app.get("/api/trash-guides/quality-profiles", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const queryValidation = GetTrashFormatsQuerySchema.safeParse(request.query);
		if (!queryValidation.success) {
			return reply.code(400).send({
				error: "Invalid query parameters",
				details: queryValidation.error.errors,
			});
		}

		const { service, ref } = queryValidation.data;

		try {
			app.log.info({
				service,
				ref,
			}, "Fetching TRaSH guides quality profiles");

			const qualityProfiles = await fetchQualityProfiles({
				service: service as ServiceType,
				ref,
			});

			app.log.info({
				service,
				ref,
				count: qualityProfiles.length,
			}, "TRaSH guides quality profiles fetched");

			return reply.send({
				qualityProfiles,
				version: ref,
				lastUpdated: new Date().toISOString(),
			});
		} catch (error) {
			app.log.error("Failed to fetch TRaSH quality profiles:", error);
			return reply.code(500).send({
				error: "Failed to fetch TRaSH quality profiles",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Apply Quality Profile to Instance
	// ========================================================================

	app.post("/api/trash-guides/apply-quality-profile", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = ApplyQualityProfileSchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, profileFileName, service, ref } = validation.data;

		try {
			// Fetch the instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (instance.service !== service) {
				return reply.code(400).send({
					error: `Instance service ${instance.service} does not match requested service ${service}`,
				});
			}

			// Fetch quality profiles data
			const qualityProfiles = await fetchQualityProfiles({
				service: service as ServiceType,
				ref,
			});

			// Find the specific quality profile
			const qualityProfile = qualityProfiles.find((profile) => profile.fileName === profileFileName);

			if (!qualityProfile) {
				return reply.code(404).send({
					error: "Quality profile not found in TRaSH guides",
				});
			}

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			// Get existing quality profiles
			const existingResponse = await fetcher("/api/v3/qualityprofile");
			const existingProfiles = await existingResponse.json();

			// Check if a profile with this name already exists
			const existingProfile = existingProfiles.find(
				(profile: any) => profile.name === qualityProfile.name
			);

			let result;
			if (existingProfile) {
				// Update existing profile
				const updateResponse = await fetcher(
					`/api/v3/qualityprofile/${existingProfile.id}`,
					{
						method: "PUT",
						body: JSON.stringify({
							...existingProfile,
							...qualityProfile,
							id: existingProfile.id,
							name: qualityProfile.name,
						}),
						headers: {
							"Content-Type": "application/json",
						},
					}
				);

				if (!updateResponse.ok) {
					const errorText = await updateResponse.text();
					app.log.error({
						statusCode: updateResponse.status,
						statusText: updateResponse.statusText,
						errorBody: errorText,
					}, "Failed to update quality profile in arr instance");
					throw new Error(`Failed to update quality profile: ${updateResponse.status} ${errorText}`);
				}

				result = await updateResponse.json();

				app.log.info({
					instanceId,
					profileName: qualityProfile.name,
				}, "Quality profile updated from TRaSH guides");

				// Track this quality profile application
				await app.prisma.trashQualityProfileTracking.upsert({
					where: {
						serviceInstanceId_profileFileName: {
							serviceInstanceId: instanceId,
							profileFileName,
						},
					},
					update: {
						profileName: qualityProfile.name,
						qualityProfileId: existingProfile.id,
						lastAppliedAt: new Date(),
						gitRef: ref,
					},
					create: {
						serviceInstanceId: instanceId,
						profileFileName,
						profileName: qualityProfile.name,
						qualityProfileId: existingProfile.id,
						service: service as any,
						gitRef: ref,
					},
				});

				return reply.send({
					message: "Quality profile updated from TRaSH guides",
					qualityProfile: result,
					action: "updated",
				});
			} else {
				// Create new profile
				const createResponse = await fetcher("/api/v3/qualityprofile", {
					method: "POST",
					body: JSON.stringify(qualityProfile),
					headers: {
						"Content-Type": "application/json",
					},
				});

				if (!createResponse.ok) {
					const errorText = await createResponse.text();
					app.log.error({
						statusCode: createResponse.status,
						statusText: createResponse.statusText,
						errorBody: errorText,
						profileName: qualityProfile.name,
					}, "Failed to create quality profile in arr instance");
					throw new Error(`Failed to create quality profile: ${createResponse.status} ${errorText}`);
				}

				result = await createResponse.json();

				app.log.info({
					instanceId,
					profileName: qualityProfile.name,
				}, "Quality profile created from TRaSH guides");

				// Track this quality profile application
				await app.prisma.trashQualityProfileTracking.create({
					data: {
						serviceInstanceId: instanceId,
						profileFileName,
						profileName: qualityProfile.name,
						qualityProfileId: result.id,
						service: service as any,
						gitRef: ref,
					},
				});

				return reply.send({
					message: "Quality profile created from TRaSH guides",
					qualityProfile: result,
					action: "created",
				});
			}
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				instanceId,
				profileFileName,
			}, "Failed to apply quality profile");
			return reply.code(500).send({
				error: "Failed to apply quality profile",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Tracked CF Groups
	// ========================================================================

	app.get("/api/trash-guides/tracked-cf-groups", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		try {
			const tracked = await app.prisma.trashCFGroupTracking.findMany({
				orderBy: [
					{ serviceInstanceId: "asc" },
					{ groupName: "asc" },
				],
				include: {
					serviceInstance: true,
				},
			});

			// Map to include instance label
			const groups = tracked.map((item) => ({
				id: item.id,
				serviceInstanceId: item.serviceInstanceId,
				groupFileName: item.groupFileName,
				groupName: item.groupName,
				service: item.service,
				importedCount: item.importedCount,
				lastSyncedAt: item.lastSyncedAt.toISOString(),
				gitRef: item.gitRef,
				createdAt: item.createdAt.toISOString(),
				updatedAt: item.updatedAt.toISOString(),
				instanceLabel: item.serviceInstance.label,
			}));

			return reply.send({ groups });
		} catch (error) {
			app.log.error("Failed to get tracked CF groups:", error);
			return reply.code(500).send({
				error: "Failed to get tracked CF groups",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Re-sync CF Group
	// ========================================================================

	app.post("/api/trash-guides/resync-cf-group", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = z.object({
			instanceId: z.string(),
			groupFileName: z.string(),
			ref: z.string().default("master"),
		}).safeParse(request.body);

		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, groupFileName, ref } = validation.data;

		try {
			// Get the tracked group to verify it exists
			const trackedGroup = await app.prisma.trashCFGroupTracking.findUnique({
				where: {
					serviceInstanceId_groupFileName: {
						serviceInstanceId: instanceId,
						groupFileName,
					},
				},
			});

			if (!trackedGroup) {
				return reply.code(404).send({ error: "Tracked CF group not found" });
			}

			// Get the instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			// Fetch CF groups data
			const cfGroups = await fetchCFGroups({
				service: instance.service as ServiceType,
				ref,
			});

			// Find the specific CF group
			const cfGroup = cfGroups.find((group) => group.fileName === groupFileName);

			if (!cfGroup) {
				return reply.code(404).send({
					error: "CF group no longer exists in TRaSH guides",
				});
			}

			// Fetch TRaSH custom formats to get the actual format data
			const trashData = await fetchTrashGuides({
				service: instance.service as ServiceType,
				ref,
			});

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			let importedCount = 0;
			let failedCount = 0;
			const results = [];

			// Re-import each custom format in the group
			for (const cfRef of cfGroup.custom_formats || []) {
				try {
					const trashFormat = trashData.customFormats.find(
						(cf) => cf.trash_id === cfRef.trash_id
					);

					if (!trashFormat) {
						failedCount++;
						results.push({
							trashId: cfRef.trash_id,
							name: cfRef.trash_id,
							status: "not_found",
						});
						continue;
					}

					// Check if this custom format already exists
					const existingResponse = await fetcher("/api/v3/customformat");
					const existingFormats = await existingResponse.json();

					const existingFormat = existingFormats.find(
						(cf: any) => cf.name === trashFormat.name
					);

					let result;
					if (existingFormat) {
						// Update existing
						const updateResponse = await fetcher(
							`/api/v3/customformat/${existingFormat.id}`,
							{
								method: "PUT",
								body: JSON.stringify({
									...existingFormat,
									name: trashFormat.name,
									includeCustomFormatWhenRenaming:
										trashFormat.includeCustomFormatWhenRenaming,
									specifications: trashFormat.specifications,
								}),
								headers: {
									"Content-Type": "application/json",
								},
							}
						);

						if (!updateResponse.ok) {
							throw new Error(`Failed to update custom format: ${updateResponse.status}`);
						}

						result = await updateResponse.json();

						// Track this custom format as TRaSH-managed
						await app.prisma.trashCustomFormatTracking.upsert({
							where: {
								serviceInstanceId_customFormatId: {
									serviceInstanceId: instanceId,
									customFormatId: result.id,
								},
							},
							update: {
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								lastSyncedAt: new Date(),
								gitRef: ref,
							},
							create: {
								serviceInstanceId: instanceId,
								customFormatId: result.id,
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								service: instance.service as any,
								gitRef: ref,
								importSource: "CF_GROUP",
								sourceReference: groupFileName,
							},
						});
					} else {
						// Create new
						const createResponse = await fetcher("/api/v3/customformat", {
							method: "POST",
							body: JSON.stringify({
								name: trashFormat.name,
								includeCustomFormatWhenRenaming:
									trashFormat.includeCustomFormatWhenRenaming,
								specifications: trashFormat.specifications,
							}),
							headers: {
								"Content-Type": "application/json",
							},
						});

						if (!createResponse.ok) {
							throw new Error(`Failed to create custom format: ${createResponse.status}`);
						}

						result = await createResponse.json();

						// Track this custom format as TRaSH-managed
						await app.prisma.trashCustomFormatTracking.create({
							data: {
								serviceInstanceId: instanceId,
								customFormatId: result.id,
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								service: instance.service as any,
								gitRef: ref,
								importSource: "CF_GROUP",
								sourceReference: groupFileName,
							},
						});
					}

					importedCount++;
					results.push({
						trashId: cfRef.trash_id,
						name: trashFormat.name,
						status: "synced",
					});
				} catch (error) {
					app.log.error({
						trashId: cfRef.trash_id,
						error: error instanceof Error ? error.message : String(error),
					}, "Failed to re-sync custom format from CF group");
					failedCount++;
					results.push({
						trashId: cfRef.trash_id,
						name: cfRef.trash_id,
						status: "failed",
					});
				}
			}

			// Update CF group tracking
			await app.prisma.trashCFGroupTracking.update({
				where: {
					serviceInstanceId_groupFileName: {
						serviceInstanceId: instanceId,
						groupFileName,
					},
				},
				data: {
					groupName: cfGroup.name,
					importedCount,
					lastSyncedAt: new Date(),
					gitRef: ref,
				},
			});

			return reply.send({
				message: `Re-synced ${importedCount} custom format(s) from group, ${failedCount} failed`,
				synced: importedCount,
				failed: failedCount,
				results,
				groupName: cfGroup.name,
			});
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				instanceId,
				groupFileName,
			}, "Failed to re-sync CF group");
			return reply.code(500).send({
				error: "Failed to re-sync CF group",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Tracked Quality Profiles
	// ========================================================================

	app.get("/api/trash-guides/tracked-quality-profiles", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		try {
			const tracked = await app.prisma.trashQualityProfileTracking.findMany({
				orderBy: [
					{ serviceInstanceId: "asc" },
					{ profileName: "asc" },
				],
				include: {
					serviceInstance: true,
				},
			});

			// Map to include instance label
			const profiles = tracked.map((item) => ({
				id: item.id,
				serviceInstanceId: item.serviceInstanceId,
				profileFileName: item.profileFileName,
				profileName: item.profileName,
				qualityProfileId: item.qualityProfileId,
				service: item.service,
				lastAppliedAt: item.lastAppliedAt.toISOString(),
				gitRef: item.gitRef,
				createdAt: item.createdAt.toISOString(),
				updatedAt: item.updatedAt.toISOString(),
				instanceLabel: item.serviceInstance.label,
			}));

			return reply.send({ profiles });
		} catch (error) {
			app.log.error("Failed to get tracked quality profiles:", error);
			return reply.code(500).send({
				error: "Failed to get tracked quality profiles",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Re-apply Quality Profile
	// ========================================================================

	app.post("/api/trash-guides/reapply-quality-profile", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const validation = z.object({
			instanceId: z.string(),
			profileFileName: z.string(),
			ref: z.string().default("master"),
		}).safeParse(request.body);

		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { instanceId, profileFileName, ref } = validation.data;

		try {
			// Get the tracked profile to verify it exists
			const trackedProfile = await app.prisma.trashQualityProfileTracking.findUnique({
				where: {
					serviceInstanceId_profileFileName: {
						serviceInstanceId: instanceId,
						profileFileName,
					},
				},
			});

			if (!trackedProfile) {
				return reply.code(404).send({ error: "Tracked quality profile not found" });
			}

			// Get the instance
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			// Fetch quality profiles data
			const qualityProfiles = await fetchQualityProfiles({
				service: instance.service as ServiceType,
				ref,
			});

			// Find the specific quality profile
			const qualityProfile = qualityProfiles.find((profile) => profile.fileName === profileFileName);

			if (!qualityProfile) {
				return reply.code(404).send({
					error: "Quality profile no longer exists in TRaSH guides",
				});
			}

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			// Get existing quality profiles
			const existingResponse = await fetcher("/api/v3/qualityprofile");
			const existingProfiles = await existingResponse.json();

			// Check if a profile with this ID exists (prefer ID over name for re-apply)
			const existingProfile = trackedProfile.qualityProfileId
				? existingProfiles.find((profile: any) => profile.id === trackedProfile.qualityProfileId)
				: existingProfiles.find((profile: any) => profile.name === qualityProfile.name);

			let result;
			if (existingProfile) {
				// Update existing profile
				const updateResponse = await fetcher(
					`/api/v3/qualityprofile/${existingProfile.id}`,
					{
						method: "PUT",
						body: JSON.stringify({
							...existingProfile,
							...qualityProfile,
							id: existingProfile.id,
							name: qualityProfile.name,
						}),
						headers: {
							"Content-Type": "application/json",
						},
					}
				);

				if (!updateResponse.ok) {
					const errorText = await updateResponse.text();
					throw new Error(`Failed to update quality profile: ${updateResponse.status} ${errorText}`);
				}

				result = await updateResponse.json();

				// Update tracking
				await app.prisma.trashQualityProfileTracking.update({
					where: {
						serviceInstanceId_profileFileName: {
							serviceInstanceId: instanceId,
							profileFileName,
						},
					},
					data: {
						profileName: qualityProfile.name,
						qualityProfileId: existingProfile.id,
						lastAppliedAt: new Date(),
						gitRef: ref,
					},
				});

				return reply.send({
					message: "Quality profile re-applied from TRaSH guides",
					qualityProfile: result,
					action: "updated",
				});
			} else {
				return reply.code(404).send({
					error: "Tracked quality profile no longer exists in Sonarr/Radarr. It may have been deleted.",
				});
			}
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				instanceId,
				profileFileName,
			}, "Failed to re-apply quality profile");
			return reply.code(500).send({
				error: "Failed to re-apply quality profile",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
