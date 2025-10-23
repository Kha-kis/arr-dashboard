/**
 * Quality Profiles Routes
 * Manage quality profiles, scoring, and TRaSH Guides integration
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";
import { fetchTrashGuides } from "../lib/arr-sync/trash/trash-fetcher.js";
import {
	resolveTemplates,
	type MergeContext,
	type CustomFormat,
	type Template,
} from "../lib/custom-formats/template-merge-engine.js";

export async function profilesRoutes(app: FastifyInstance) {
	/**
	 * GET /api/profiles/quality-profiles/:instanceId
	 * Fetch all quality profiles from an ARR instance
	 */
	app.get(
		"/api/profiles/quality-profiles/:instanceId",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId } = request.params as { instanceId: string };

			try {
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
						error: `Instance service ${instance.service} does not support quality profiles`,
					});
				}

				// Fetch quality profiles from ARR instance
				const fetcher = createInstanceFetcher(app, instance);
				const response = await fetcher("/api/v3/qualityprofile");

				if (!response.ok) {
					return reply.code(response.status).send({
						error: `Failed to fetch quality profiles: ${response.statusText}`,
					});
				}

				const qualityProfiles = await response.json();

				return reply.send({
					instanceId,
					instanceLabel: instance.label,
					instanceService: instance.service,
					qualityProfiles,
				});
			} catch (error) {
				app.log.error("Failed to fetch quality profiles:", error);
				return reply.code(500).send({
					error: "Failed to fetch quality profiles",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	/**
	 * GET /api/profiles/overlays/:instanceId
	 * Get template overlay configuration for an instance
	 */
	app.get("/api/profiles/overlays/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const { instanceId } = request.params as { instanceId: string };

		try {
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			// Fetch overlay configuration from database
			const overlay = await app.prisma.templateOverlay.findUnique({
				where: { serviceInstanceId: instanceId },
			});

			return reply.send({
				instanceId,
				instanceLabel: instance.label,
				overlay: overlay || {
					includes: [],
					excludes: [],
					overrides: [],
					lastAppliedAt: null,
				},
			});
		} catch (error) {
			app.log.error("Failed to fetch template overlay:", error);
			return reply.code(500).send({
				error: "Failed to fetch template overlay",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * PUT /api/profiles/overlays/:instanceId
	 * Update template overlay configuration for an instance
	 */
	app.put("/api/profiles/overlays/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const { instanceId } = request.params as { instanceId: string };

		const bodySchema = z.object({
			includes: z.array(z.string()),
			excludes: z.array(z.string()),
			overrides: z.array(
				z.object({
					trash_id: z.string(),
					score: z.number(),
				}),
			),
		});

		const validation = bodySchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { includes, excludes, overrides } = validation.data;

		try {
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			// Upsert overlay configuration
			const overlay = await app.prisma.templateOverlay.upsert({
				where: { serviceInstanceId: instanceId },
				create: {
					serviceInstanceId: instanceId,
					includes,
					excludes,
					overrides,
				},
				update: {
					includes,
					excludes,
					overrides,
				},
			});

			return reply.send({
				success: true,
				overlay,
			});
		} catch (error) {
			app.log.error("Failed to update template overlay:", error);
			return reply.code(500).send({
				error: "Failed to update template overlay",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/profiles/preview/:instanceId
	 * Preview template overlay changes before applying
	 */
	app.post("/api/profiles/preview/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const { instanceId } = request.params as { instanceId: string };

		const bodySchema = z.object({
			includes: z.array(z.string()).default([]),
			excludes: z.array(z.string()).default([]),
			overrides: z
				.array(
					z.object({
						trash_id: z.string(),
						score: z.number(),
					}),
				)
				.default([]),
		});

		const validation = bodySchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { includes, excludes, overrides } = validation.data;

		try {
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
					error: `Instance service ${instance.service} does not support quality profiles`,
				});
			}

			// Fetch current custom formats from ARR instance
			const fetcher = createInstanceFetcher(app, instance);
			const cfResponse = await fetcher("/api/v3/customformat");

			if (!cfResponse.ok) {
				return reply.code(cfResponse.status).send({
					error: `Failed to fetch custom formats: ${cfResponse.statusText}`,
				});
			}

			const currentCFs: CustomFormat[] = await cfResponse.json();

			// If no includes, just return current state
			if (includes.length === 0) {
				return reply.send({
					instanceId,
					instanceLabel: instance.label,
					changes: {
						added: [],
						modified: [],
						removed: [],
					},
					warnings: ["No templates selected for preview"],
				});
			}

			// Fetch TRaSH templates
			const trashData = await fetchTrashGuides({
				service: instance.service,
				ref: "master",
			});

			// Build templates array from includes
			const templates: Template[] = includes.map((templateId) => {
				// Find all CFs matching this template ID pattern
				const matchingCFs = trashData.customFormats.filter((cf) =>
					cf.trash_id?.toLowerCase().includes(templateId.toLowerCase()),
				);

				return {
					id: templateId,
					name: templateId,
					customFormats: matchingCFs,
				};
			});

			// Convert overrides array to Record format
			const overridesRecord: Record<string, any> = {};
			for (const override of overrides) {
				overridesRecord[override.trash_id] = {
					score: override.score,
				};
			}

			// Build merge context
			const mergeContext: MergeContext = {
				baseCFs: currentCFs,
				templates,
				includes,
				excludes,
				overrides: overridesRecord,
			};

			// Resolve templates and compute diff
			const mergeResult = resolveTemplates(mergeContext);

			// Group changes by type
			const added = mergeResult.changes
				.filter((c) => c.changeType === "added")
				.map((c) => ({
					cfId: c.cfId,
					name: c.name,
					changes: c.changes,
					after: c.after,
				}));

			const modified = mergeResult.changes
				.filter((c) => c.changeType === "modified")
				.map((c) => ({
					cfId: c.cfId,
					name: c.name,
					changes: c.changes,
					before: c.before,
					after: c.after,
				}));

			const removed = mergeResult.changes
				.filter((c) => c.changeType === "removed")
				.map((c) => ({
					cfId: c.cfId,
					name: c.name,
					changes: c.changes,
					before: c.before,
				}));

			return reply.send({
				instanceId,
				instanceLabel: instance.label,
				changes: {
					added,
					modified,
					removed,
				},
				warnings: mergeResult.warnings,
			});
		} catch (error) {
			app.log.error("Failed to preview template overlay:", error);
			return reply.code(500).send({
				error: "Failed to preview template overlay",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	/**
	 * POST /api/profiles/apply/:instanceId
	 * Apply template overlay to an instance
	 */
	app.post("/api/profiles/apply/:instanceId", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const { instanceId } = request.params as { instanceId: string };

		const bodySchema = z.object({
			includes: z.array(z.string()).default([]),
			excludes: z.array(z.string()).default([]),
			overrides: z
				.array(
					z.object({
						trash_id: z.string(),
						score: z.number(),
					}),
				)
				.default([]),
			dryRun: z.boolean().default(false),
		});

		const validation = bodySchema.safeParse(request.body);
		if (!validation.success) {
			return reply.code(400).send({
				error: "Invalid request body",
				details: validation.error.errors,
			});
		}

		const { includes, excludes, overrides, dryRun } = validation.data;

		try {
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
					error: `Instance service ${instance.service} does not support quality profiles`,
				});
			}

			// Fetch current custom formats from ARR instance
			const fetcher = createInstanceFetcher(app, instance);
			const cfResponse = await fetcher("/api/v3/customformat");

			if (!cfResponse.ok) {
				return reply.code(cfResponse.status).send({
					error: `Failed to fetch custom formats: ${cfResponse.statusText}`,
				});
			}

			const currentCFs: CustomFormat[] = await cfResponse.json();

			// Fetch TRaSH templates if includes are specified
			let resolvedCFs: CustomFormat[] = currentCFs;
			let warnings: string[] = [];

			if (includes.length > 0) {
				// Fetch TRaSH templates
				const trashData = await fetchTrashGuides({
					service: instance.service,
					ref: "master",
				});

				// Build templates array from includes
				const templates: Template[] = includes.map((templateId) => {
					// Find all CFs matching this template ID pattern
					const matchingCFs = trashData.customFormats.filter((cf) =>
						cf.trash_id?.toLowerCase().includes(templateId.toLowerCase()),
					);

					return {
						id: templateId,
						name: templateId,
						customFormats: matchingCFs,
					};
				});

				// Convert overrides array to Record format
				const overridesRecord: Record<string, any> = {};
				for (const override of overrides) {
					overridesRecord[override.trash_id] = {
						score: override.score,
					};
				}

				// Build merge context
				const mergeContext: MergeContext = {
					baseCFs: currentCFs,
					templates,
					includes,
					excludes,
					overrides: overridesRecord,
				};

				// Resolve templates and compute diff
				const mergeResult = resolveTemplates(mergeContext);
				resolvedCFs = mergeResult.resolvedCFs;
				warnings = mergeResult.warnings;
			}

			// Update overlay configuration in database
			await app.prisma.templateOverlay.upsert({
				where: { serviceInstanceId: instanceId },
				create: {
					serviceInstanceId: instanceId,
					includes,
					excludes,
					overrides,
					lastAppliedAt: dryRun ? null : new Date(),
				},
				update: {
					includes,
					excludes,
					overrides,
					lastAppliedAt: dryRun ? undefined : new Date(),
				},
			});

			// If dry run, just return the preview
			if (dryRun) {
				return reply.send({
					instanceId,
					instanceLabel: instance.label,
					success: true,
					applied: {
						created: 0,
						updated: 0,
						deleted: 0,
					},
					warnings: [
						"Dry run - no changes applied to ARR instance",
						...warnings,
					],
				});
			}

			// Apply changes to ARR instance
			let created = 0;
			let updated = 0;
			let deleted = 0;

			// Build maps for efficient lookup
			const currentCFsMap = new Map<string, CustomFormat>();
			for (const cf of currentCFs) {
				const key = cf.trash_id || cf.id?.toString() || cf.name;
				currentCFsMap.set(key, cf);
			}

			const resolvedCFsMap = new Map<string, CustomFormat>();
			for (const cf of resolvedCFs) {
				const key = cf.trash_id || cf.name;
				resolvedCFsMap.set(key, cf);
			}

			// Delete CFs that are in current but not in resolved
			for (const [key, currentCF] of currentCFsMap.entries()) {
				if (!resolvedCFsMap.has(key) && currentCF.id) {
					try {
						const deleteResponse = await fetcher(
							`/api/v3/customformat/${currentCF.id}`,
							{
								method: "DELETE",
							},
						);

						if (deleteResponse.ok) {
							deleted++;
						} else {
							warnings.push(
								`Failed to delete CF "${currentCF.name}": ${deleteResponse.statusText}`,
							);
						}
					} catch (error) {
						warnings.push(
							`Error deleting CF "${currentCF.name}": ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}

			// Create or update CFs
			for (const [key, resolvedCF] of resolvedCFsMap.entries()) {
				const currentCF = currentCFsMap.get(key);

				try {
					if (currentCF && currentCF.id) {
						// Update existing CF
						const updateData = { ...resolvedCF, id: currentCF.id };
						const updateResponse = await fetcher(
							`/api/v3/customformat/${currentCF.id}`,
							{
								method: "PUT",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify(updateData),
							},
						);

						if (updateResponse.ok) {
							updated++;
						} else {
							warnings.push(
								`Failed to update CF "${resolvedCF.name}": ${updateResponse.statusText}`,
							);
						}
					} else {
						// Create new CF (remove id field)
						const { id, ...createData } = resolvedCF;
						const createResponse = await fetcher("/api/v3/customformat", {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
							},
							body: JSON.stringify(createData),
						});

						if (createResponse.ok) {
							created++;
						} else {
							warnings.push(
								`Failed to create CF "${resolvedCF.name}": ${createResponse.statusText}`,
							);
						}
					}
				} catch (error) {
					warnings.push(
						`Error syncing CF "${resolvedCF.name}": ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			return reply.send({
				instanceId,
				instanceLabel: instance.label,
				success: true,
				applied: {
					created,
					updated,
					deleted,
				},
				warnings,
			});
		} catch (error) {
			app.log.error("Failed to apply template overlay:", error);
			return reply.code(500).send({
				error: "Failed to apply template overlay",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	app.log.info("Profiles routes registered");
}
