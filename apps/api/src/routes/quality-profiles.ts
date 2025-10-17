/**
 * Quality Profiles Routes
 * Manage quality profiles and their custom format scores
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";

// Request schemas
const GetQualityProfilesQuerySchema = z.object({
	instanceId: z.string(),
});

const UpdateProfileScoresSchema = z.object({
	instanceId: z.string(),
	profileId: z.number(),
	customFormatScores: z.array(
		z.object({
			customFormatId: z.number(),
			score: z.number(),
		}),
	),
});

export async function qualityProfilesRoutes(app: FastifyInstance) {
	// ========================================================================
	// Get All Quality Profiles for an Instance
	// ========================================================================

	app.get("/api/quality-profiles", async (request, reply) => {
		if (!request.currentUser) {
			return reply.code(401).send({ error: "Unauthorized" });
		}

		const queryValidation = GetQualityProfilesQuerySchema.safeParse(
			request.query,
		);
		if (!queryValidation.success) {
			return reply.code(400).send({
				error: "Invalid query parameters",
				details: queryValidation.error.errors,
			});
		}

		const { instanceId } = queryValidation.data;

		try {
			const instance = await app.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				return reply.code(404).send({ error: "Instance not found" });
			}

			if (instance.service !== "SONARR" && instance.service !== "RADARR") {
				return reply.code(400).send({
					error: `Instance service ${instance.service} does not support quality profiles`,
				});
			}

			const fetcher = createInstanceFetcher(app, instance);
			const response = await fetcher("/api/v3/qualityprofile");
			const profiles = await response.json();

			app.log.info({
				instanceId,
				instanceLabel: instance.label,
				profileCount: Array.isArray(profiles) ? profiles.length : 0,
			}, "Quality profiles fetched");

			return reply.send({ profiles });
		} catch (error) {
			app.log.error("Failed to get quality profiles:", error);
			return reply.code(500).send({
				error: "Failed to get quality profiles",
				details: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// ========================================================================
	// Get Single Quality Profile
	// ========================================================================

	app.get(
		"/api/quality-profiles/:instanceId/:profileId",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId, profileId } = request.params as {
				instanceId: string;
				profileId: string;
			};

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

				const fetcher = createInstanceFetcher(app, instance);
				const response = await fetcher(
					`/api/v3/qualityprofile/${profileId}`,
				);
				const profile = await response.json();

				return reply.send(profile);
			} catch (error) {
				app.log.error("Failed to get quality profile:", error);
				return reply.code(500).send({
					error: "Failed to get quality profile",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);

	// ========================================================================
	// Update Quality Profile Custom Format Scores
	// ========================================================================

	app.put(
		"/api/quality-profiles/:instanceId/:profileId/scores",
		async (request, reply) => {
			if (!request.currentUser) {
				return reply.code(401).send({ error: "Unauthorized" });
			}

			const { instanceId, profileId } = request.params as {
				instanceId: string;
				profileId: string;
			};

			const validation = z
				.object({
					customFormatScores: z.array(
						z.object({
							customFormatId: z.number(),
							score: z.number(),
						}),
					),
				})
				.safeParse(request.body);

			if (!validation.success) {
				return reply.code(400).send({
					error: "Invalid request body",
					details: validation.error.errors,
				});
			}

			const { customFormatScores } = validation.data;

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

				const fetcher = createInstanceFetcher(app, instance);

				// First, get the existing profile
				const existingResponse = await fetcher(
					`/api/v3/qualityprofile/${profileId}`,
				);
				const existing = await existingResponse.json();

				// Create a map of custom format scores
				const scoresMap = new Map(
					customFormatScores.map((s) => [s.customFormatId, s.score]),
				);

				// Update the formatItems with new scores
				// Handle both lowercase and capitalized property names for compatibility
				const updatedFormatItems = (existing.formatItems || []).map(
					(item: any) => {
						const formatId = item.format || item.Format;
						const newScore = scoresMap.get(formatId);
						return {
							...item,
							// Ensure we use capitalized properties for Radarr API
							Format: formatId,
							Name: item.name || item.Name || "",
							Score: newScore !== undefined ? newScore : (item.score || item.Score || 0),
							// Remove lowercase properties to avoid confusion
							format: undefined,
							name: undefined,
							score: undefined,
						};
					},
				).map((item: any) => {
					// Clean up undefined properties
					const { format, name, score, ...cleanItem } = item;
					return cleanItem;
				});

				// Add any new custom formats that weren't in the profile
				for (const [formatId, score] of scoresMap.entries()) {
					if (
						!updatedFormatItems.some(
							(item: any) => (item.format || item.Format) === formatId,
						)
					) {
						// Use capitalized properties for new items
						updatedFormatItems.push({
							Format: formatId,
							Name: "", // Name should be filled by the API
							Score: score,
						});
					}
				}

				// Update the profile
				const updated = {
					...existing,
					formatItems: updatedFormatItems,
				};

				const resultResponse = await fetcher(
					`/api/v3/qualityprofile/${profileId}`,
					{
						method: "PUT",
						body: JSON.stringify(updated),
						headers: {
							"Content-Type": "application/json",
						},
					},
				);
				const result = await resultResponse.json();

				app.log.info({
					instanceId,
					profileId,
					scoresUpdated: customFormatScores.length,
				}, "Quality profile scores updated");

				return reply.send(result);
			} catch (error) {
				app.log.error("Failed to update quality profile scores:", error);
				return reply.code(500).send({
					error: "Failed to update quality profile scores",
					details:
						error instanceof Error ? error.message : String(error),
				});
			}
		},
	);
}
