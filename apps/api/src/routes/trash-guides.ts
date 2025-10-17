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

			// Fetch all CF group tracking to map filenames to display names and quality profile names
			const cfGroupTracking = await app.prisma.trashCFGroupTracking.findMany();
			const cfGroupMap = new Map(
				cfGroupTracking.map((g) => [`${g.serviceInstanceId}:${g.groupFileName}`, {
					groupName: g.groupName,
					qualityProfileName: g.qualityProfileName
				}])
			);

			// Fetch all quality profile tracking to map filenames to display names
			const qpTracking = await app.prisma.trashQualityProfileTracking.findMany();
			const qpMap = new Map(
				qpTracking.map((p) => [`${p.serviceInstanceId}:${p.profileFileName}`, p.profileName])
			);

			// Group by instance
			const byInstance = tracked.reduce((acc, item) => {
				if (!acc[item.serviceInstanceId]) {
					acc[item.serviceInstanceId] = [];
				}

				// Resolve display name based on import source
				let sourceDisplayName: string | null = null;
				let associatedQualityProfile: string | null = null;

				if (item.importSource === "CF_GROUP" && item.sourceReference) {
					const cfGroupInfo = cfGroupMap.get(`${item.serviceInstanceId}:${item.sourceReference}`);
					sourceDisplayName = cfGroupInfo?.groupName || null;
					// If this CF Group is part of a Quality Profile, include that info
					associatedQualityProfile = cfGroupInfo?.qualityProfileName || null;
				} else if (item.importSource === "QUALITY_PROFILE" && item.sourceReference) {
					sourceDisplayName = qpMap.get(`${item.serviceInstanceId}:${item.sourceReference}`) || null;
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
					sourceDisplayName: sourceDisplayName, // Friendly display name for CF Group or QP
					associatedQualityProfile: associatedQualityProfile, // Quality Profile name if CF Group is part of one
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

				// Debug: Log the structure of the quality profile
				app.log.info({
					profileName: qualityProfile.name,
					profileKeys: Object.keys(qualityProfile),
					cutoff: qualityProfile.cutoff,
					cutoffType: typeof qualityProfile.cutoff,
					hasItems: !!qualityProfile.items,
					itemsCount: qualityProfile.items?.length || 0,
					sampleItems: qualityProfile.items?.slice(0, 3),
					upgradeUntilQuality: qualityProfile.upgradeUntilQuality,
					upgradeAllowed: qualityProfile.upgradeAllowed,
					// Debug formatItems structure
					formatItems: qualityProfile.formatItems,
					formatItemsType: typeof qualityProfile.formatItems,
					formatItemsKeys: qualityProfile.formatItems ? Object.keys(qualityProfile.formatItems) : null,
					formatItemsIsArray: Array.isArray(qualityProfile.formatItems),
				}, "TRaSH quality profile structure");

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			// Get existing quality profiles
			const existingResponse = await fetcher("/api/v3/qualityprofile");
			const existingProfiles = await existingResponse.json();

			// Check if a profile with this name already exists
			const existingProfile = existingProfiles.find(
				(profile: any) => profile.name === qualityProfile.name
			);

			/**
			 * Fetch Radarr's quality schema to get quality definitions with IDs
			 * Based on recyclarr's approach: use schema to properly merge with TRaSH profiles
			 */
			const schemaResponse = await fetcher("/api/v3/qualityprofile/schema");
			const schema = await schemaResponse.json();

			/**
			 * Helper: Recursively reverse items (Radarr/Sonarr stores in reverse order)
			 * Must be called before POST/PUT
			 */
			function reverseItems(items: any[]): any[] {
				return items.slice().reverse().map((item) => {
					if (item.items && Array.isArray(item.items)) {
						return { ...item, items: reverseItems(item.items) };
					}
					return item;
				});
			}

			/**
			 * Helper: Flatten items recursively to search all qualities
			 */
			function flattenItems(items: any[]): any[] {
				const result: any[] = [];
				for (const item of items) {
					result.push(item);
					if (item.items && Array.isArray(item.items)) {
						result.push(...flattenItems(item.items));
					}
				}
				return result;
			}

			/**
			 * Helper: Find cutoff ID from organized items
			 * Cutoff must be a top-level allowed item (quality or group)
			 * Based on recyclarr's FindCutoff + FirstCutoffId logic
			 */
			function findCutoffId(items: any[], cutoffName?: string): number {
				// Get eligible cutoffs (only allowed top-level items)
				const eligibleCutoffs = items
					.filter((item) => item.allowed === true)
					.map((item) => ({
						name: item.quality?.name || item.name,
						id: item.quality?.id || item.id,
					}))
					.filter((x) => x.id != null);

				// If cutoff name specified, try to find it
				if (cutoffName) {
					const found = eligibleCutoffs.find(
						(x) => x.name?.toLowerCase() === cutoffName.toLowerCase()
					);
					if (found && found.id != null) {
						app.log.info({
							cutoffName,
							resolvedId: found.id,
							resolvedName: found.name,
						}, "Resolved cutoff by name");
						return found.id;
					}
				}

				// Fallback: First allowed item (required - cutoff cannot be null)
				const firstCutoff = eligibleCutoffs[0];
				if (!firstCutoff || firstCutoff.id == null) {
					throw new Error("No eligible cutoff found (no allowed items in profile)");
				}

				app.log.info({
					cutoffName: cutoffName || "(not specified)",
					fallbackId: firstCutoff.id,
					fallbackName: firstCutoff.name,
				}, "Using first allowed item as cutoff (fallback)");

				return firstCutoff.id;
			}

			/**
			 * Helper: Merge TRaSH items (names only) with schema items (have IDs/structure)
			 * TRaSH profiles only have quality names, we need to match them to schema items
			 */
			function mergeItemsWithSchema(trashItems: any[], schemaItems: any[]): any[] {
				app.log.info({
					trashItemsCount: trashItems.length,
					schemaItemsCount: schemaItems.length,
					trashItemsStructure: trashItems.slice(0, 5).map(item => ({
						name: item.name,
						allowed: item.allowed,
						hasItems: !!item.items?.length,
						itemsCount: item.items?.length || 0
					})),
					schemaItemsStructure: schemaItems.slice(0, 5).map(item => ({
						name: item.name || item.quality?.name,
						id: item.id || item.quality?.id,
						hasItems: !!item.items?.length,
						itemsCount: item.items?.length || 0
					}))
				}, "Starting mergeItemsWithSchema");

				// Build a map of schema items by name for quick lookup
				const schemaMap = new Map<string, any>();

				function indexSchema(items: any[]) {
					for (const item of items) {
						const name = item.quality?.name || item.name;
						if (name) {
							schemaMap.set(name.toLowerCase(), item);
						}
						if (item.items?.length) {
							indexSchema(item.items);
						}
					}
				}
				indexSchema(schemaItems);

				app.log.info({
					schemaMapSize: schemaMap.size,
					schemaMapKeys: Array.from(schemaMap.keys()).slice(0, 10)
				}, "Schema map built");

				// Map TRaSH items to schema items, preserving allowed flags
				const merged = trashItems.map((trashItem, index) => {
					app.log.info({
						index,
						trashItemName: trashItem.name,
						trashItemAllowed: trashItem.allowed,
						lookupKey: trashItem.name?.toLowerCase()
					}, `Processing TRaSH item ${index}`);

					const schemaItem = schemaMap.get(trashItem.name?.toLowerCase());

					if (!schemaItem) {
						app.log.warn({ 
							trashItemName: trashItem.name,
							availableKeys: Array.from(schemaMap.keys()).slice(0, 10)
						}, "TRaSH item not found in schema");
						return null;
					}

					app.log.info({
						trashItemName: trashItem.name,
						matchedSchemaItem: {
							name: schemaItem.name || schemaItem.quality?.name,
							id: schemaItem.id || schemaItem.quality?.id,
							allowed: schemaItem.allowed
						}
					}, "Found schema match");

					// Build merged item with schema structure + TRaSH allowed flag
					const mergedItem: any = {
						...schemaItem,
						allowed: trashItem.allowed ?? schemaItem.allowed,
					};

					// If TRaSH item has nested items (group), merge them too
					if (trashItem.items && Array.isArray(trashItem.items) && trashItem.items.length > 0) {
						const nestedItems = trashItem.items
							.map((nestedName: string) => {
								const nestedSchema = schemaMap.get(nestedName.toLowerCase());
								if (!nestedSchema) {
									app.log.warn({ nestedName, groupName: trashItem.name }, "Nested TRaSH item not found in schema");
									return null;
								}
								return { ...nestedSchema, allowed: true };
							})
							.filter((x: any) => x != null);

						if (nestedItems.length > 0) {
							mergedItem.items = nestedItems;
						}
					}

					return mergedItem;
				}).filter((x) => x != null);

				app.log.info({
					originalCount: trashItems.length,
					mergedCount: merged.length,
					mergedItemsStructure: merged.slice(0, 3).map(item => ({
						name: item.name || item.quality?.name,
						id: item.id || item.quality?.id,
						allowed: item.allowed
					}))
				}, "Merge completed");

				return merged;
			}

			/**
			 * Transform formatItems to match Radarr/Sonarr API expectations
			 * Based on recyclarr's ProfileFormatItemDto:
			 * { Format: number, Name: string, Score: number }
			 * 
			 * This function resolves custom format IDs from names and ensures
			 * the structure matches what Radarr expects.
			 */
			async function transformFormatItems(formatItems: any, existingFormats: any[]): Promise<any[]> {
				const transformed = [];
				
				// Handle different possible formatItems structures
				if (!formatItems) {
					return [];
				}
				
				// If formatItems is an object (like formatItems2, formatItems3, etc.)
				if (typeof formatItems === 'object' && !Array.isArray(formatItems)) {
					// Convert object to array of format items
					const formatItemsArray = [];
					for (const [key, value] of Object.entries(formatItems)) {
						if (typeof value === 'object' && value !== null) {
							formatItemsArray.push(value);
						}
					}
					formatItems = formatItemsArray;
				}
				
				// If it's still not iterable, return empty array
				if (!Array.isArray(formatItems)) {
					app.log.warn({
						formatItemsType: typeof formatItems,
						formatItemsValue: formatItems,
					}, "formatItems is not iterable, returning empty array");
					return [];
				}
				
				for (const item of formatItems) {
					// Handle different possible structures
					const formatName = item.name || item.Name || "";
					const formatId = item.format || item.Format;
					const score = item.score || item.Score || 0;
					
					// If we have a format ID, use it directly
					if (formatId) {
						transformed.push({
							Format: formatId,
							Name: formatName,
							Score: score,
						});
						continue;
					}
					
					// If we only have a name, try to resolve the ID from existing formats
					if (formatName) {
						const existingFormat = existingFormats.find(
							(cf: any) => cf.name === formatName
						);
						
						if (existingFormat) {
							transformed.push({
								Format: existingFormat.id,
								Name: existingFormat.name,
								Score: score,
							});
						} else {
							app.log.warn({
								formatName,
								score,
							}, "Custom format referenced in quality profile formatItems not found in instance - skipping");
						}
					}
				}
				
				return transformed;
			}

			/**
			 * Build quality profile payload for Radarr/Sonarr
			 * Based on recyclarr's approach:
			 * 1. Merge TRaSH items with schema to get IDs
			 * 2. Assign cutoff AFTER items are organized
			 * 3. Reverse items before sending
			 * 4. Transform formatItems to proper structure
			 */
			async function buildQualityProfilePayload(trashProfile: any, schemaOrExisting: any, existingFormats: any[]) {
				// Get schema items for merging
				const schemaItems = schemaOrExisting.items || [];

				// Merge TRaSH items (names + allowed flags) with schema (IDs + structure)
				let items: any[];
				if (trashProfile.items && trashProfile.items.length > 0) {
					items = mergeItemsWithSchema(trashProfile.items, schemaItems);
				} else {
					// No TRaSH items, use schema as-is
					items = schemaItems;
				}

				// Debug: Log merged items structure
				app.log.info({
					profileName: trashProfile.name,
					itemsCount: items.length,
					sampleItems: items.slice(0, 3).map((item: any) => ({
						name: item.name || item.quality?.name,
						quality: item.quality,
						allowed: item.allowed,
						id: item.id,
						hasNestedItems: !!item.items?.length,
					})),
				}, "Items merged with schema");

				// Find cutoff ID from organized items (AFTER items are set)
				// The cutoff in TRaSH profile is the NAME of the quality/group
				const cutoffName = trashProfile.upgradeUntilQuality || trashProfile.cutoff;
				let cutoffId = findCutoffId(items, cutoffName);

				// If cutoff ID is not found, use the highest quality item as fallback
				if (!cutoffId && items.length > 0) {
					app.log.warn({
						profileName: trashProfile.name,
						cutoffName,
						availableItems: items.map(i => ({ name: i.name || i.quality?.name, id: i.id || i.quality?.id }))
					}, "Cutoff quality not found, using fallback");

					// Find the highest quality ID as fallback
					for (const item of items) {
						if (item.quality && item.quality.id) {
							cutoffId = item.quality.id;
							break;
						} else if (item.id) {
							cutoffId = item.id;
							break;
						}
					}
				}

				// Transform formatItems to proper structure (capitalize properties)
				const transformedFormatItems = await transformFormatItems(trashProfile.formatItems, existingFormats);

				// Debug: Log formatItems structure
				app.log.info({
					profileName: trashProfile.name,
					originalFormatItems: trashProfile.formatItems,
					originalFormatItemsType: typeof trashProfile.formatItems,
					originalFormatItemsIsArray: Array.isArray(trashProfile.formatItems),
					originalFormatItemsKeys: trashProfile.formatItems ? Object.keys(trashProfile.formatItems) : null,
					transformedFormatItems: transformedFormatItems.slice(0, 3),
					formatItemsCount: transformedFormatItems.length,
				}, "FormatItems transformation");

				// Validate items array is not empty
				if (!items || items.length === 0) {
					throw new Error(`Quality profile '${trashProfile.name}' has no quality items. Items array is empty or invalid.`);
				}

				// Validate that items contain valid quality data
				const validItems = items.filter(item => 
					item && 
					(item.id !== undefined || (item.quality && item.quality.id !== undefined))
				);

				if (validItems.length === 0) {
					throw new Error(`Quality profile '${trashProfile.name}' has no valid quality items with IDs.`);
				}

				// Build payload
				const payload: any = {
					name: trashProfile.name,
					upgradeAllowed: trashProfile.upgradeAllowed ?? true,
					minFormatScore: trashProfile.minFormatScore ?? 0,
					cutoff: cutoffId,  // Assigned AFTER items
					cutoffFormatScore: trashProfile.cutoffFormatScore ?? 0,
					formatItems: transformedFormatItems,  // Use transformed formatItems
					items: reverseItems(validItems),  // Use validated items and reverse before sending
				};

				// Only include language if it's a valid value (object with id property)
				if (trashProfile.language && typeof trashProfile.language === 'object' && trashProfile.language.id) {
					payload.language = trashProfile.language;
				}

				app.log.info({
					profileName: trashProfile.name,
					cutoffId: payload.cutoff,
					itemsCount: items.length,
					formatItemsCount: payload.formatItems.length,
				}, "Quality profile payload built");

				return payload;
			}

			// Fetch TRaSH custom formats data for the pipeline (BEFORE creating pipeline)
			// This ensures the pipeline can import actual TRaSH format specifications
			const trashData = await fetchTrashGuides({
				service: service as ServiceType,
				ref,
			});

			app.log.info({
				profileName: qualityProfile.name,
				instanceName: instance.label,
				trashFormatsCount: trashData.customFormats.length,
			}, "Fetched TRaSH data for pipeline-based quality profile sync (recyclarr-style workflow)");

			// Fetch existing custom formats to resolve formatItems
			const existingFormatsResponse = await fetcher("/api/v3/customformat");
			const existingFormats = await existingFormatsResponse.json();

			// Use pipeline-only approach (no legacy fallback)
			const { SimplePipelineService } = await import('../lib/simple-pipeline-service.js');

			// Create the pipeline service WITH TRaSH data and tracking parameters
			const pipelineService = new SimplePipelineService(
				fetcher,
				app.log,
				trashData,
				app.prisma,
				instanceId,
				instance.service,
				ref
			);

			// Apply the profile using pipeline workflow
			// The pipeline will:
			// 1. Import all custom formats referenced in the profile (with actual TRaSH specifications)
			// 2. Then apply the quality profile
			const pipelineResult = await pipelineService.applyProfile(
				qualityProfile.name,
				qualityProfile, // Pass the entire TRaSH profile
				profileFileName // Pass filename for tracking
			);

			if (!pipelineResult.success) {
				throw new Error(pipelineResult.message || 'Pipeline failed to apply quality profile');
			}

			app.log.info({ message: pipelineResult.message }, "Pipeline-based quality profile sync completed");

			// Get the actual applied profile from Radarr to return proper response
			const appliedProfilesResponse = await fetcher("/api/v3/qualityprofile");
			const appliedProfiles = await appliedProfilesResponse.json();
			const result = appliedProfiles.find((p: any) => p.name === qualityProfile.name);

			if (!result) {
				throw new Error(`Quality profile '${qualityProfile.name}' was not found after pipeline application`);
			}

			const action = result.id ? 'applied' : 'created';

			// Note: Custom formats are already imported by the pipeline, so we don't need separate tracking here
			// The pipeline handles both creation and tracking of custom formats
			const importedCFs = {
				note: 'Custom formats imported by pipeline in Phase 1'
			};

			app.log.info({
				profileName: result.name,
				profileId: result.id,
				action,
			}, "Quality profile successfully applied via pipeline");

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
					qualityProfileId: result.id,
					lastAppliedAt: new Date(),
					gitRef: ref,
				},
				create: {
					serviceInstanceId: instanceId,
					profileFileName,
					profileName: qualityProfile.name,
					qualityProfileId: result.id,
					service: service as any,
					gitRef: ref,
				},
			});

			return reply.send({
				message: `Quality profile ${action} from TRaSH guides`,
				qualityProfile: result,
				action: action,
				importedCFs,
			});
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

			// For each CF-Group, fetch the custom formats that belong to it
			const groupsWithFormats = await Promise.all(
				tracked.map(async (item) => {
					// Find all custom formats that were imported from this CF-Group
					const customFormats = await app.prisma.trashCustomFormatTracking.findMany({
						where: {
							serviceInstanceId: item.serviceInstanceId,
							importSource: "CF_GROUP",
							sourceReference: item.groupFileName,
						},
						orderBy: {
							customFormatName: "asc",
						},
					});

					return {
						id: item.id,
						serviceInstanceId: item.serviceInstanceId,
						groupFileName: item.groupFileName,
						groupName: item.groupName,
						qualityProfileName: item.qualityProfileName,
						service: item.service,
						importedCount: item.importedCount,
						lastSyncedAt: item.lastSyncedAt.toISOString(),
						gitRef: item.gitRef,
						createdAt: item.createdAt.toISOString(),
						updatedAt: item.updatedAt.toISOString(),
						instanceLabel: item.serviceInstance.label,
						customFormats: customFormats.map((cf) => ({
							id: cf.id,
							customFormatId: cf.customFormatId,
							customFormatName: cf.customFormatName,
							trashId: cf.trashId,
							lastSyncedAt: cf.lastSyncedAt.toISOString(),
						})),
					};
				})
			);

			return reply.send({ groups: groupsWithFormats });
		} catch (error) {
			app.log.error("Failed to get tracked CF groups:", error);
			return reply.code(500).send({
				error: "Failed to get tracked CF groups",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Untrack CF Group
	// ========================================================================

	app.delete("/api/trash-guides/tracked-cf-groups/:instanceId/:groupFileName", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const paramsValidation = z.object({
			instanceId: z.string(),
			groupFileName: z.string(),
		}).safeParse(request.params);

		if (!paramsValidation.success) {
			return reply.code(400).send({
				error: "Invalid parameters",
				details: paramsValidation.error.errors,
			});
		}

		const queryValidation = z.object({
			deleteFormats: z.enum(["true", "false"]).optional().default("true"),
		}).safeParse(request.query);

		if (!queryValidation.success) {
			return reply.code(400).send({
				error: "Invalid query parameters",
				details: queryValidation.error.errors,
			});
		}

		const { instanceId, groupFileName } = paramsValidation.data;
		const { deleteFormats } = queryValidation.data;
		const shouldDeleteFormats = deleteFormats === "true";

		try {
			// Handle groupFileName with or without .json extension
			// Database stores with .json, but we accept either format
			const normalizedGroupFileName = groupFileName.endsWith('.json')
				? groupFileName
				: `${groupFileName}.json`;

			// Verify the tracked CF group exists
			const trackedGroup = await app.prisma.trashCFGroupTracking.findUnique({
				where: {
					serviceInstanceId_groupFileName: {
						serviceInstanceId: instanceId,
						groupFileName: normalizedGroupFileName,
					},
				},
				include: {
					serviceInstance: true,
				},
			});

			if (!trackedGroup) {
				return reply.code(404).send({ error: "Tracked CF group not found" });
			}

			// Get all tracked custom formats for this instance that were imported from this CF group
			const formatsToUntrack = await app.prisma.trashCustomFormatTracking.findMany({
				where: {
					serviceInstanceId: instanceId,
					importSource: "CF_GROUP",
					sourceReference: normalizedGroupFileName,
				},
			});

			// Get the service instance to access the API
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			const { createInstanceFetcher } = await import("../lib/arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(app, instance);

			let untrackedCount = 0;
			let failedCount = 0;
			const results = [];

			// Process each format that was imported from this CF group
			for (const formatTracking of formatsToUntrack) {
				try {
					// Check if the custom format still exists in Sonarr/Radarr
					let existingFormat = null;
					try {
						const existingResponse = await fetcher(`/api/v3/customformat/${formatTracking.customFormatId}`);
						if (existingResponse.ok) {
							existingFormat = await existingResponse.json();
						}
					} catch (error) {
						// Format doesn't exist, which is fine
						existingFormat = null;
					}

					if (!existingFormat) {
						// Format doesn't exist, just remove tracking
						await app.prisma.trashCustomFormatTracking.delete({
							where: {
								serviceInstanceId_customFormatId: {
									serviceInstanceId: instanceId,
									customFormatId: formatTracking.customFormatId,
								},
							},
						});
						untrackedCount++;
						results.push({
							customFormatId: formatTracking.customFormatId,
							name: formatTracking.customFormatName,
							status: "tracking_only_removed",
						});
						continue;
					}

					// If format still exists in Sonarr/Radarr, we have two options:
					// 1. Delete the format from Sonarr/Radarr (if shouldDeleteFormats is true)
					// 2. Keep the format but change tracking to INDIVIDUAL (if shouldDeleteFormats is false)

					if (shouldDeleteFormats) {
						// Delete the format from Sonarr/Radarr
						const deleteResponse = await fetcher(
							`/api/v3/customformat/${formatTracking.customFormatId}`,
							{
								method: "DELETE",
							}
						);

						if (!deleteResponse.ok) {
							app.log.error({
								statusCode: deleteResponse.status,
								formatName: existingFormat.name,
							}, "Failed to delete custom format during CF group untrack");
							failedCount++;
							results.push({
								customFormatId: formatTracking.customFormatId,
								name: formatTracking.customFormatName,
								status: "delete_failed",
							});
							continue;
						}

						// Remove the tracking record
						await app.prisma.trashCustomFormatTracking.delete({
							where: {
								serviceInstanceId_customFormatId: {
									serviceInstanceId: instanceId,
									customFormatId: formatTracking.customFormatId,
								},
							},
						});

						untrackedCount++;
						results.push({
							customFormatId: formatTracking.customFormatId,
							name: formatTracking.customFormatName,
							status: "untracked_and_deleted",
						});
					} else {
						// Keep the format but convert tracking to INDIVIDUAL
						await app.prisma.trashCustomFormatTracking.update({
							where: {
								serviceInstanceId_customFormatId: {
									serviceInstanceId: instanceId,
									customFormatId: formatTracking.customFormatId,
								},
							},
							data: {
								importSource: "INDIVIDUAL",
								sourceReference: null,
							},
						});

						untrackedCount++;
						results.push({
							customFormatId: formatTracking.customFormatId,
							name: formatTracking.customFormatName,
							status: "converted_to_individual",
						});
					}
				} catch (error) {
					app.log.error({
						customFormatId: formatTracking.customFormatId,
						error: error instanceof Error ? error.message : String(error),
					}, "Failed to untrack custom format from CF group");
					failedCount++;
					results.push({
						customFormatId: formatTracking.customFormatId,
						name: formatTracking.customFormatName,
						status: "error",
					});
				}
			}

			// Remove the CF group tracking record
			await app.prisma.trashCFGroupTracking.delete({
				where: {
					serviceInstanceId_groupFileName: {
						serviceInstanceId: instanceId,
						groupFileName: normalizedGroupFileName,
					},
				},
			});

			app.log.info({
				instanceId,
				groupFileName,
				instanceLabel: trackedGroup.serviceInstance.label,
				service: trackedGroup.service,
				untrackedCount,
				failedCount,
			}, "CF group untracked successfully");

			const action = shouldDeleteFormats ? "removed" : "converted to individual tracking";
			return reply.send({
				message: `Untracked CF group "${trackedGroup.groupName}". ${shouldDeleteFormats ? "Removed" : "Converted"} ${untrackedCount} custom formats${shouldDeleteFormats ? "" : " to individual tracking"}, ${failedCount} failed.`,
				untracked: untrackedCount,
				failed: failedCount,
				results,
				groupName: trackedGroup.groupName,
				action: shouldDeleteFormats ? "deleted" : "converted",
			});
		} catch (error) {
			app.log.error({
				error: error instanceof Error ? error.message : String(error),
				instanceId,
				groupFileName,
			}, "Failed to untrack CF group");
			return reply.code(500).send({
				error: "Failed to untrack CF group",
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
			// Handle groupFileName with or without .json extension
			// Database stores with .json, but we accept either format
			const normalizedGroupFileName = groupFileName.endsWith('.json')
				? groupFileName
				: `${groupFileName}.json`;

			// Get the tracked group to verify it exists
			const trackedGroup = await app.prisma.trashCFGroupTracking.findUnique({
				where: {
					serviceInstanceId_groupFileName: {
						serviceInstanceId: instanceId,
						groupFileName: normalizedGroupFileName,
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
			// Note: TRaSH groups have .json extension in their fileName
			const cfGroup = cfGroups.find((group) => group.fileName === normalizedGroupFileName);

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
								sourceReference: normalizedGroupFileName,
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
								sourceReference: normalizedGroupFileName,
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
						groupFileName: normalizedGroupFileName,
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

			// Get existing quality profiles to check if the profile exists
			// NOTE: If the profile doesn't exist in Radarr, we'll create it (don't return 404)
			const existingResponse = await fetcher("/api/v3/qualityprofile");
			const existingProfiles = await existingResponse.json();

			// Check if a profile with this ID exists (prefer ID over name for re-apply)
			const existingProfile = trackedProfile.qualityProfileId
				? existingProfiles.find((profile: any) => profile.id === trackedProfile.qualityProfileId)
				: existingProfiles.find((profile: any) => profile.name === qualityProfile.name);

			if (!existingProfile) {
				app.log.info({
					profileName: qualityProfile.name,
					qualityProfileId: trackedProfile.qualityProfileId,
				}, "Tracked quality profile no longer exists in Radarr - will recreate it via pipeline");
			}

			// Use the SAME pipeline approach as apply-quality-profile
			// The pipeline handles both creating and updating profiles

			// Fetch TRaSH custom formats data for the pipeline
			const trashData = await fetchTrashGuides({
				service: instance.service as ServiceType,
				ref,
			});

			app.log.info({
				profileName: qualityProfile.name,
				instanceName: instance.label,
				trashFormatsCount: trashData.customFormats.length,
			}, "Fetched TRaSH data for pipeline-based quality profile re-apply");

			// Use pipeline service to properly apply the profile
			const { SimplePipelineService } = await import('../lib/simple-pipeline-service.js');
			const pipelineService = new SimplePipelineService(
				fetcher,
				app.log,
				trashData,
				app.prisma,
				instanceId,
				instance.service,
				ref
			);

			// Apply the profile using pipeline workflow (same as apply endpoint)
			const pipelineResult = await pipelineService.applyProfile(
				qualityProfile.name,
				qualityProfile,
				profileFileName // Pass filename for tracking
			);

			if (!pipelineResult.success) {
				throw new Error(pipelineResult.message || 'Pipeline failed to re-apply quality profile');
			}

			app.log.info({ message: pipelineResult.message }, "Pipeline-based quality profile re-apply completed");

			// Get the updated profile from Radarr
			const updatedProfilesResponse = await fetcher("/api/v3/qualityprofile");
			const updatedProfiles = await updatedProfilesResponse.json();
			const result = updatedProfiles.find((p: any) => p.name === qualityProfile.name);

			if (!result) {
				throw new Error(`Quality profile '${qualityProfile.name}' was not found after pipeline re-application`);
			}

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
					qualityProfileId: result.id,
					lastAppliedAt: new Date(),
					gitRef: ref,
				},
			});

			app.log.info({
				profileName: result.name,
				profileId: result.id,
			}, "Quality profile successfully re-applied via pipeline");

			return reply.send({
				message: "Quality profile re-applied from TRaSH guides",
				qualityProfile: result,
				action: "updated",
			});
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
