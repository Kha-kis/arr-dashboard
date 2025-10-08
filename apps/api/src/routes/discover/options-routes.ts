import {
	discoverInstanceOptionsRequestSchema,
	discoverInstanceOptionsResponseSchema,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import { toBoolean, toNumber, toStringValue } from "../../lib/data/values.js";

/**
 * Type alias for dynamic API responses. Uses `any` to allow flexible property access
 * while safety is enforced through helper functions (toStringValue, toNumber, etc.)
 */
// biome-ignore lint/suspicious/noExplicitAny: Runtime safety enforced via helper functions
type UnknownRecord = Record<string, any>;

/**
 * Register discover options routes
 * - GET /discover/options - Get instance configuration options
 */
export const registerOptionsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /discover/options
	 * Fetches quality profiles, root folders, and language profiles for an instance
	 */
	app.get("/discover/options", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return reply.send();
		}

		const parsed = discoverInstanceOptionsRequestSchema.parse(request.query ?? {});
		const instance = await app.prisma.serviceInstance.findFirst({
			where: {
				id: parsed.instanceId,
				userId: request.currentUser.id,
				enabled: true,
			},
		});

		if (!instance) {
			reply.status(404);
			return reply.send({ message: "Instance not found" });
		}

		const service = instance.service.toLowerCase() as "sonarr" | "radarr";
		const expected = parsed.type === "movie" ? "radarr" : "sonarr";
		if (service !== expected) {
			reply.status(400);
			return reply.send({
				message: `Instance does not support ${parsed.type}`,
			});
		}

		try {
			const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
			const qualityProfilesResponse = await fetcher("/api/v3/qualityprofile");
			const rootFolderResponse = await fetcher("/api/v3/rootfolder");

			const qualityProfilesRaw = await qualityProfilesResponse.json();
			const rootFoldersRaw = await rootFolderResponse.json();

			const qualityProfiles = Array.isArray(qualityProfilesRaw)
				? qualityProfilesRaw
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
						)
				: [];

			const rootFolders = Array.isArray(rootFoldersRaw)
				? rootFoldersRaw.reduce<
						Array<{
							id?: number | string;
							path: string;
							accessible?: boolean;
							freeSpace?: number;
						}>
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
					}, [])
				: [];

			let languageProfiles: Array<{ id: number; name: string }> | undefined;
			if (service === "sonarr") {
				try {
					const languageResponse = await fetcher("/api/v3/languageprofile");
					const languageRaw = await languageResponse.json();
					languageProfiles = Array.isArray(languageRaw)
						? languageRaw
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
								)
						: [];
				} catch (error) {
					request.log.warn(
						{ err: error, instance: instance.id },
						"failed to load language profiles",
					);
				}
			}

			return discoverInstanceOptionsResponseSchema.parse({
				instanceId: instance.id,
				service,
				qualityProfiles,
				rootFolders,
				languageProfiles,
			});
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "failed to load discover options");
			reply.status(502);
			return reply.send({ message: "Failed to load instance options" });
		}
	});

	done();
};
