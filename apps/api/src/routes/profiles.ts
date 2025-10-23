/**
 * Quality Profiles Routes
 * Manage quality profiles, scoring, and TRaSH Guides integration
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";

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

			// TODO: Implement actual preview logic
			// For now, return a placeholder response
			return reply.send({
				instanceId,
				instanceLabel: instance.label,
				changes: {
					added: [],
					modified: [],
					removed: [],
				},
				warnings: ["Preview functionality not yet implemented"],
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

			// TODO: Implement actual apply logic
			// For now, return a placeholder response
			return reply.send({
				instanceId,
				instanceLabel: instance.label,
				success: true,
				applied: {
					created: 0,
					updated: 0,
					deleted: 0,
				},
				warnings: dryRun
					? ["Dry run - no changes applied to ARR instance"]
					: ["Apply functionality not yet fully implemented"],
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
