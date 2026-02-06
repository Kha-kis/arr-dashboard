import {
	discoverInstanceOptionsRequestSchema,
	discoverInstanceOptionsResponseSchema,
	discoverTestOptionsRequestSchema,
	discoverTestOptionsResponseSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	getClientForInstance,
	isSonarrClient,
	isRadarrClient,
} from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";
import { SonarrClient, RadarrClient } from "arr-sdk";
import { toBoolean, toNumber, toStringValue } from "../../lib/data/values.js";
import { getInstanceOptionsWithSdk } from "../../lib/discover/discover-normalizer.js";

/**
 * Type alias for dynamic API responses. Uses `any` to allow flexible property access
 * while safety is enforced through helper functions (toStringValue, toNumber, etc.)
 */
// biome-ignore lint/suspicious/noExplicitAny: Runtime safety enforced via helper functions
type UnknownRecord = Record<string, any>;

// ============================================================================
// Shared Transformation Helpers
// ============================================================================

/**
 * Transform raw quality profiles response into typed array
 */
function transformQualityProfiles(raw: unknown): Array<{ id: number; name: string }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((profile: unknown) => {
			const p = profile as UnknownRecord;
			return {
				id: toNumber(p?.id),
				name: toStringValue(p?.name),
			};
		})
		.filter(
			(profile): profile is { id: number; name: string } =>
				typeof profile.id === "number" && typeof profile.name === "string",
		);
}

/**
 * Transform raw root folders response into typed array
 */
function transformRootFolders(
	raw: unknown,
): Array<{ id?: number | string; path: string; accessible?: boolean; freeSpace?: number }> {
	if (!Array.isArray(raw)) return [];
	return raw.reduce<
		Array<{ id?: number | string; path: string; accessible?: boolean; freeSpace?: number }>
	>((acc, folder: unknown) => {
		const f = folder as UnknownRecord;
		const path = toStringValue(f?.path);
		if (!path) {
			return acc;
		}
		acc.push({
			id: toNumber(f?.id) ?? toStringValue(f?.id) ?? undefined,
			path,
			accessible: toBoolean(f?.accessible),
			freeSpace: toNumber(f?.freeSpace),
		});
		return acc;
	}, []);
}

/**
 * Transform raw language profiles response into typed array
 */
function transformLanguageProfiles(raw: unknown): Array<{ id: number; name: string }> {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((profile: unknown) => {
			const p = profile as UnknownRecord;
			return {
				id: toNumber(p?.id),
				name: toStringValue(p?.name),
			};
		})
		.filter(
			(profile): profile is { id: number; name: string } =>
				typeof profile.id === "number" && typeof profile.name === "string",
		);
}

/**
 * Register discover options routes
 * - GET /discover/options - Get instance configuration options
 * - POST /discover/test-options - Get configuration options without saved instance
 */
export const registerOptionsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /discover/options
	 * Fetches quality profiles, root folders, and language profiles for an instance
	 */
	app.get("/discover/options", async (request, reply) => {
		const parsed = discoverInstanceOptionsRequestSchema.parse(request.query ?? {});

		const clientResult = await getClientForInstance(app, request, parsed.instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return reply.send({ message: clientResult.error });
		}

		const { client, instance } = clientResult;
		const service = instance.service.toLowerCase() as "sonarr" | "radarr";
		const expected = parsed.type === "movie" ? "radarr" : "sonarr";

		if (service !== expected) {
			reply.status(400);
			return reply.send({
				message: `Instance does not support ${parsed.type}`,
			});
		}

		// Validate client type matches expected service
		if (service === "radarr" && !isRadarrClient(client)) {
			reply.status(400);
			return reply.send({ message: "Instance is not a Radarr instance" });
		}
		if (service === "sonarr" && !isSonarrClient(client)) {
			reply.status(400);
			return reply.send({ message: "Instance is not a Sonarr instance" });
		}

		try {
			// biome-ignore lint/suspicious/noExplicitAny: Type already validated by isSonarrClient/isRadarrClient guards above
			const options = await getInstanceOptionsWithSdk(client as any, service);

			return discoverInstanceOptionsResponseSchema.parse({
				instanceId: instance.id,
				service,
				qualityProfiles: options.qualityProfiles,
				rootFolders: options.rootFolders,
				languageProfiles: options.languageProfiles,
			});
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "failed to load discover options");

			if (error instanceof ArrError) {
				reply.status(arrErrorToHttpStatus(error));
			} else {
				reply.status(502);
			}
			return reply.send({ message: "Failed to load instance options" });
		}
	});

	/**
	 * POST /discover/test-options
	 * Fetches quality profiles, root folders, and language profiles using temporary credentials
	 * Used during service setup before instance is saved to database
	 */
	app.post("/discover/test-options", async (request, reply) => {
		const parsed = discoverTestOptionsRequestSchema.parse(request.body ?? {});
		const service = parsed.service.toLowerCase() as "sonarr" | "radarr";

		try {
			// Create SDK client directly with provided credentials (not from database)
			const clientConfig = {
				baseUrl: parsed.baseUrl.replace(/\/$/, ""),
				apiKey: parsed.apiKey,
				timeout: 30_000,
			};

			if (service === "sonarr") {
				const client = new SonarrClient(clientConfig);
				const [qualityProfilesRaw, rootFoldersRaw] = await Promise.all([
					client.qualityProfile.getAll(),
					client.rootFolder.getAll(),
				]);

				const qualityProfiles = transformQualityProfiles(qualityProfilesRaw);
				const rootFolders = transformRootFolders(rootFoldersRaw);

				let languageProfiles: Array<{ id: number; name: string }> | undefined;
				try {
					const languageRaw = await client.languageProfile.getAll();
					languageProfiles = transformLanguageProfiles(languageRaw);
				} catch (error) {
					request.log.warn({ err: error }, "failed to load language profiles");
				}

				return discoverTestOptionsResponseSchema.parse({
					service,
					qualityProfiles,
					rootFolders,
					languageProfiles,
				});
			}

			// Radarr
			const client = new RadarrClient(clientConfig);
			const [qualityProfilesRaw, rootFoldersRaw] = await Promise.all([
				client.qualityProfile.getAll(),
				client.rootFolder.getAll(),
			]);

			const qualityProfiles = transformQualityProfiles(qualityProfilesRaw);
			const rootFolders = transformRootFolders(rootFoldersRaw);

			return discoverTestOptionsResponseSchema.parse({
				service,
				qualityProfiles,
				rootFolders,
			});
		} catch (error) {
			request.log.error({ err: error, baseUrl: parsed.baseUrl }, "failed to load test options");
			reply.status(502);
			return reply.send({ message: "Failed to load test options" });
		}
	});

	done();
};
