/**
 * Quality Profile Clone API Routes
 *
 * Routes for importing complete quality profiles from *arr instances
 */

import { FastifyPluginCallback } from "fastify";
import { createProfileCloner } from "../../lib/trash-guides/profile-cloner.js";
import type { CompleteQualityProfile } from "@arr/shared";

// ============================================================================
// Routes
// ============================================================================

const profileCloneRoutes: FastifyPluginCallback = (app, opts, done) => {
	/**
	 * POST /api/trash-guides/profile-clone/import
	 * Import complete quality profile from *arr instance
	 */
	app.post("/import", async (request, reply) => {
		const userId = request.userId!;
		const {
			instanceId,
			profileId,
		} = request.body as {
			instanceId: string;
			profileId: number;
		};

		try {
			const profileCloner = createProfileCloner(app.prisma, app.encryptor);
			const result = await profileCloner.importQualityProfile({
				instanceId,
				profileId,
				userId,
			});

			if (!result.success) {
				return reply.status(400).send({
					success: false,
					error: result.error,
				});
			}

			return reply.status(200).send({
				success: true,
				data: {
					profile: result.profile,
				},
			});
		} catch (error) {
			app.log.error(`Failed to import quality profile: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to import profile",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/preview
	 * Preview deployment of complete quality profile
	 */
	app.post("/preview", async (request, reply) => {
		const userId = request.userId!;
		const {
			instanceId,
			profile,
			customFormats,
		} = request.body as {
			instanceId: string;
			profile: CompleteQualityProfile;
			customFormats: Array<{ trash_id: string; score: number }>;
		};

		try {
			const profileCloner = createProfileCloner(app.prisma, app.encryptor);
			const result = await profileCloner.previewProfileDeployment(
				instanceId,
				userId,
				profile,
				customFormats,
			);

			if (!result.success) {
				return reply.status(400).send({
					success: false,
					error: result.error,
				});
			}

			return reply.status(200).send({
				success: true,
				data: result.preview,
			});
		} catch (error) {
			app.log.error(`Failed to preview profile deployment: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to preview deployment",
			});
		}
	});

	/**
	 * POST /api/trash-guides/profile-clone/deploy
	 * Deploy complete quality profile to *arr instance
	 */
	app.post("/deploy", async (request, reply) => {
		const userId = request.userId!;
		const {
			instanceId,
			profile,
			customFormats,
			profileName,
			existingProfileId,
		} = request.body as {
			instanceId: string;
			profile: CompleteQualityProfile;
			customFormats: Array<{ trash_id: string; score: number }>;
			profileName: string;
			existingProfileId?: number;
		};

		try {
			const profileCloner = createProfileCloner(app.prisma, app.encryptor);
			const result = await profileCloner.deployCompleteProfile(
				instanceId,
				userId,
				profile,
				customFormats,
				{
					profileName,
					existingProfileId,
				},
			);

			if (!result.success) {
				return reply.status(400).send({
					success: false,
					error: result.error,
				});
			}

			return reply.status(200).send({
				success: true,
				data: {
					profileId: result.profileId,
				},
			});
		} catch (error) {
			app.log.error(`Failed to deploy complete profile: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to deploy profile",
			});
		}
	});

	/**
	 * GET /api/trash-guides/profile-clone/profiles/:instanceId
	 * Get list of quality profiles from an instance
	 */
	app.get("/profiles/:instanceId", async (request, reply) => {
		const userId = request.userId!;
		const { instanceId } = request.params as { instanceId: string };

		try {
			// Get instance (owned by current user)
			const instance = await app.prisma.serviceInstance.findFirst({
				where: {
					id: instanceId,
					userId, // Enforce ownership
				},
			});

			if (!instance) {
				return reply.status(404).send({
					success: false,
					error: "Instance not found or access denied",
				});
			}

			// Decrypt API key
			const apiKey = app.encryptor.decrypt({
				value: instance.encryptedApiKey,
				iv: instance.encryptionIv,
			});
			const baseUrl = instance.baseUrl?.replace(/\/$/, "") || "";

			if (!baseUrl || !apiKey) {
				return reply.status(400).send({
					success: false,
					error: "Instance credentials incomplete",
				});
			}

			// Fetch quality profiles
			const profilesUrl = `${baseUrl}/api/v3/qualityprofile`;
			const response = await fetch(profilesUrl, {
				headers: {
					"X-Api-Key": apiKey,
					Accept: "application/json",
				},
			});

			if (!response.ok) {
				return reply.status(500).send({
					success: false,
					error: `Failed to fetch profiles: ${response.statusText}`,
				});
			}

			const profiles = await response.json();

			return reply.status(200).send({
				success: true,
				data: {
					profiles: profiles.map((p: any) => ({
						id: p.id,
						name: p.name,
						upgradeAllowed: p.upgradeAllowed,
						cutoff: p.cutoff,
						cutoffQuality: p.cutoffQuality,
						minFormatScore: p.minFormatScore,
						formatItemsCount: p.formatItems?.length || 0,
					})),
				},
			});
		} catch (error) {
			app.log.error(`Failed to fetch quality profiles: ${error}`);
			return reply.status(500).send({
				success: false,
				error: error instanceof Error ? error.message : "Failed to fetch profiles",
			});
		}
	});

	done();
};

export default profileCloneRoutes;
