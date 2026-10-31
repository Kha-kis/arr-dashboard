import {
	ARR_SERVICES_UPPER,
	type DashboardStatisticsResponse,
	dashboardStatisticsEnvelopeSchema,
	dashboardStatisticsResponseSchema,
} from "@arr/shared";
import { LidarrClient, ProwlarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { FastifyBaseLogger, FastifyInstance, FastifyPluginCallback } from "fastify";
import { streamLibraryItems } from "../../lib/arr/library-stream.js";
import {
	fingerprintDashboardSources,
	readDashboardSnapshot,
} from "../../lib/statistics/dashboard-statistics-snapshot.js";
import { requestDashboardStatisticsRefresh } from "../../lib/statistics/dashboard-statistics-refresh.js";
import {
	aggregateLidarrStatistics,
	aggregateProwlarrStatistics,
	aggregateRadarrStatistics,
	aggregateReadarrStatistics,
	aggregateSonarrStatistics,
	emptyLidarrStatistics,
	emptyProwlarrStatistics,
	emptyRadarrStatistics,
	emptyReadarrStatistics,
	emptySonarrStatistics,
	fetchLidarrStatisticsWithSdk,
	fetchProwlarrStatisticsWithSdk,
	fetchRadarrStatisticsWithSdk,
	fetchReadarrStatisticsWithSdk,
	fetchSonarrStatisticsWithSdk,
} from "../../lib/statistics/dashboard-statistics.js";
import { buildCombinedDiskPayload } from "../../lib/statistics/statistics-utils.js";

/** Retains the existing provider aggregation off the latency-sensitive GET path. */
export async function collectDashboardStatistics(
	app: FastifyInstance,
	userId: string,
	log: FastifyBaseLogger,
	options: { legacyTotals?: boolean } = {},
): Promise<{ data: DashboardStatisticsResponse; partial: boolean }> {
	const includeFailedInTotals = options.legacyTotals === true;
	const instances = await app.prisma.serviceInstance.findMany({
		where: { enabled: true, userId },
	});

	// Filter to ARR-compatible services only (integration services use different clients)
	const arrInstances = instances.filter((i) =>
		(ARR_SERVICES_UPPER as readonly string[]).includes(i.service),
	);

	// Fetch all instances in parallel for better performance
	const fetchResults = await Promise.all(
		arrInstances.map(async (instance, sourceOrdinal) => {
			const service = instance.service.toLowerCase();
			let providerIncomplete = false;
			const markIncomplete = (phase: "ancillary" | "stream") => {
				if (providerIncomplete) return;
				providerIncomplete = true;
				try {
					log.warn(
						{ category: "dashboard-statistics-provider-incomplete", service, sourceOrdinal, phase },
						"Dashboard statistics provider data is incomplete",
					);
				} catch {
					// Logging cannot change the incomplete-data decision.
				}
			};
			const providerStartedAt = Date.now();
			const timedStreamItems = () =>
				(async function* () {
					const startedAt = Date.now();
					let completed = false;
					try {
						yield* streamLibraryItems(app.arrClientFactory, instance, log, { timeoutMs: 60_000 });
						completed = true;
					} finally {
						try {
							log.info(
								{
									category: "dashboard-statistics-stream-timing",
									service,
									sourceOrdinal,
									outcome: completed ? "complete" : "interrupted",
									durationMs: Math.max(0, Date.now() - startedAt),
								},
								"Dashboard statistics stream timing",
							);
						} catch {
							// Diagnostics must not change stream or response behavior.
						}
					}
				})();
			const logProviderTiming = () => {
				// Only fixed service type and duration; never log instance
				// identity, URL, title, upstream response, or credential.
				try {
					log.info(
						{
							category: "dashboard-statistics-provider-timing",
							service,
							sourceOrdinal,
							durationMs: Math.max(0, Date.now() - providerStartedAt),
						},
						"Dashboard statistics provider timing",
					);
				} catch {
					// Diagnostics must not change the statistics response.
				}
			};
			// A client-construction failure degrades only this source. Each
			// service branch below returns an explicit error-marked fallback.
			let client: ReturnType<typeof app.arrClientFactory.create> | null = null;
			try {
				client = app.arrClientFactory.create(instance);
			} catch {
				log.error(
					{ category: "dashboard-statistics-client-unavailable", service, sourceOrdinal },
					"arr client construction failed (likely encryption key mismatch); per-instance fetch will use the empty-stats fallback",
				);
			}

			if (service === "sonarr") {
				try {
					if (!(client instanceof SonarrClient)) throw new Error("client unavailable");
					const data = await fetchSonarrStatisticsWithSdk(
						client,
						instance.id,
						instance.label,
						instance.baseUrl,
						instance.externalUrl ?? undefined,
						{
							streamItems: timedStreamItems,
							log,
							markIncomplete,
						},
					);
					return {
						service: "sonarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data,
						error: providerIncomplete,
					};
				} catch {
					log.error(
						{ category: "dashboard-statistics-provider-failed", service, sourceOrdinal },
						"sonarr statistics fetch failed",
					);
					return {
						service: "sonarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data: emptySonarrStatistics,
						error: true,
					};
				} finally {
					logProviderTiming();
				}
			}

			if (service === "radarr") {
				try {
					if (!(client instanceof RadarrClient)) throw new Error("client unavailable");
					const data = await fetchRadarrStatisticsWithSdk(
						client,
						instance.id,
						instance.label,
						instance.baseUrl,
						instance.externalUrl ?? undefined,
						{
							streamItems: timedStreamItems,
							log,
							markIncomplete,
						},
					);
					return {
						service: "radarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data,
						error: providerIncomplete,
					};
				} catch {
					log.error(
						{ category: "dashboard-statistics-provider-failed", service, sourceOrdinal },
						"radarr statistics fetch failed",
					);
					return {
						service: "radarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data: emptyRadarrStatistics,
						error: true,
					};
				} finally {
					logProviderTiming();
				}
			}

			if (service === "prowlarr") {
				try {
					if (!(client instanceof ProwlarrClient)) throw new Error("client unavailable");
					const data = await fetchProwlarrStatisticsWithSdk(
						client,
						instance.id,
						instance.label,
						instance.baseUrl,
						instance.externalUrl ?? undefined,
						{ markIncomplete },
					);
					return {
						service: "prowlarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						data,
						error: providerIncomplete,
					};
				} catch {
					log.error(
						{ category: "dashboard-statistics-provider-failed", service, sourceOrdinal },
						"prowlarr statistics fetch failed",
					);
					return {
						service: "prowlarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						data: emptyProwlarrStatistics,
						error: true,
					};
				} finally {
					logProviderTiming();
				}
			}

			if (service === "lidarr") {
				try {
					if (!(client instanceof LidarrClient)) throw new Error("client unavailable");
					const data = await fetchLidarrStatisticsWithSdk(
						client,
						instance.id,
						instance.label,
						instance.baseUrl,
						instance.externalUrl ?? undefined,
						{
							streamItems: timedStreamItems,
							log,
							markIncomplete,
						},
					);
					return {
						service: "lidarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data,
						error: providerIncomplete,
					};
				} catch {
					log.error(
						{ category: "dashboard-statistics-provider-failed", service, sourceOrdinal },
						"lidarr statistics fetch failed",
					);
					return {
						service: "lidarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data: emptyLidarrStatistics,
						error: true,
					};
				} finally {
					logProviderTiming();
				}
			}

			if (service === "readarr") {
				try {
					if (!(client instanceof ReadarrClient)) throw new Error("client unavailable");
					const data = await fetchReadarrStatisticsWithSdk(
						client,
						instance.id,
						instance.label,
						instance.baseUrl,
						instance.externalUrl ?? undefined,
						{
							streamItems: timedStreamItems,
							log,
							markIncomplete,
						},
					);
					return {
						service: "readarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data,
						error: providerIncomplete,
					};
				} catch {
					log.error(
						{ category: "dashboard-statistics-provider-failed", service, sourceOrdinal },
						"readarr statistics fetch failed",
					);
					return {
						service: "readarr" as const,
						instanceId: instance.id,
						instanceName: instance.label,
						storageGroupId: instance.storageGroupId,
						data: emptyReadarrStatistics,
						error: true,
					};
				} finally {
					logProviderTiming();
				}
			}

			logProviderTiming();
			log.warn(
				{ category: "dashboard-statistics-service-unsupported", service, sourceOrdinal },
				"unknown service type for statistics",
			);
			return null;
		}),
	);

	// Track storage groups GLOBALLY across all service types for disk deduplication
	// This ensures that if Sonarr and Radarr share the same storage group,
	// disk stats are only counted once total (not once per service type)
	const globalSeenStorageGroups = new Set<string>();

	// Group results by service type and mark which should count disk stats
	const sonarrInstances: Array<{
		instanceId: string;
		instanceName: string;
		storageGroupId: string | null;
		shouldCountDisk: boolean;
		data: DashboardStatisticsResponse["sonarr"]["instances"][number]["data"];
		error?: boolean;
	}> = [];
	const radarrInstances: Array<{
		instanceId: string;
		instanceName: string;
		storageGroupId: string | null;
		shouldCountDisk: boolean;
		data: DashboardStatisticsResponse["radarr"]["instances"][number]["data"];
		error?: boolean;
	}> = [];
	const prowlarrInstances: Array<{
		instanceId: string;
		instanceName: string;
		data: DashboardStatisticsResponse["prowlarr"]["instances"][number]["data"];
		error?: boolean;
	}> = [];
	const lidarrInstances: Array<{
		instanceId: string;
		instanceName: string;
		storageGroupId: string | null;
		shouldCountDisk: boolean;
		data: DashboardStatisticsResponse["lidarr"]["instances"][number]["data"];
		error?: boolean;
	}> = [];
	const readarrInstances: Array<{
		instanceId: string;
		instanceName: string;
		storageGroupId: string | null;
		shouldCountDisk: boolean;
		data: DashboardStatisticsResponse["readarr"]["instances"][number]["data"];
		error?: boolean;
	}> = [];

	for (const result of fetchResults) {
		if (!result) continue;

		if (result.service === "sonarr") {
			// Determine if this instance should count disk stats
			const storageGroupId = result.storageGroupId;
			const shouldCountDisk =
				(includeFailedInTotals || !result.error) &&
				(!storageGroupId || !globalSeenStorageGroups.has(storageGroupId));
			if (storageGroupId && (includeFailedInTotals || !result.error)) {
				globalSeenStorageGroups.add(storageGroupId);
			}

			sonarrInstances.push({
				instanceId: result.instanceId,
				instanceName: result.instanceName,
				storageGroupId: result.storageGroupId,
				shouldCountDisk,
				data: result.data,
				error: result.error,
			});
		} else if (result.service === "radarr") {
			// Determine if this instance should count disk stats
			const storageGroupId = result.storageGroupId;
			const shouldCountDisk =
				(includeFailedInTotals || !result.error) &&
				(!storageGroupId || !globalSeenStorageGroups.has(storageGroupId));
			if (storageGroupId && (includeFailedInTotals || !result.error)) {
				globalSeenStorageGroups.add(storageGroupId);
			}

			radarrInstances.push({
				instanceId: result.instanceId,
				instanceName: result.instanceName,
				storageGroupId: result.storageGroupId,
				shouldCountDisk,
				data: result.data,
				error: result.error,
			});
		} else if (result.service === "prowlarr") {
			prowlarrInstances.push({
				instanceId: result.instanceId,
				instanceName: result.instanceName,
				data: result.data,
				error: result.error,
			});
		} else if (result.service === "lidarr") {
			// Determine if this instance should count disk stats
			const storageGroupId = result.storageGroupId;
			const shouldCountDisk =
				(includeFailedInTotals || !result.error) &&
				(!storageGroupId || !globalSeenStorageGroups.has(storageGroupId));
			if (storageGroupId && (includeFailedInTotals || !result.error)) {
				globalSeenStorageGroups.add(storageGroupId);
			}

			lidarrInstances.push({
				instanceId: result.instanceId,
				instanceName: result.instanceName,
				storageGroupId: result.storageGroupId,
				shouldCountDisk,
				data: result.data,
				error: result.error,
			});
		} else if (result.service === "readarr") {
			// Determine if this instance should count disk stats
			const storageGroupId = result.storageGroupId;
			const shouldCountDisk =
				(includeFailedInTotals || !result.error) &&
				(!storageGroupId || !globalSeenStorageGroups.has(storageGroupId));
			if (storageGroupId && (includeFailedInTotals || !result.error)) {
				globalSeenStorageGroups.add(storageGroupId);
			}

			readarrInstances.push({
				instanceId: result.instanceId,
				instanceName: result.instanceName,
				storageGroupId: result.storageGroupId,
				shouldCountDisk,
				data: result.data,
				error: result.error,
			});
		}
	}
	const usableSonarr = includeFailedInTotals
		? sonarrInstances
		: sonarrInstances.filter((entry) => !entry.error);
	const usableRadarr = includeFailedInTotals
		? radarrInstances
		: radarrInstances.filter((entry) => !entry.error);
	const usableProwlarr = includeFailedInTotals
		? prowlarrInstances
		: prowlarrInstances.filter((entry) => !entry.error);
	const usableLidarr = includeFailedInTotals
		? lidarrInstances
		: lidarrInstances.filter((entry) => !entry.error);
	const usableReadarr = includeFailedInTotals
		? readarrInstances
		: readarrInstances.filter((entry) => !entry.error);

	const payload = {
		sonarr: {
			instances: sonarrInstances,
			aggregate:
				!includeFailedInTotals && sonarrInstances.some((entry) => entry.error)
					? undefined
					: aggregateSonarrStatistics(usableSonarr),
		},
		radarr: {
			instances: radarrInstances,
			aggregate:
				!includeFailedInTotals && radarrInstances.some((entry) => entry.error)
					? undefined
					: aggregateRadarrStatistics(usableRadarr),
		},
		prowlarr: {
			instances: prowlarrInstances,
			aggregate:
				!includeFailedInTotals && prowlarrInstances.some((entry) => entry.error)
					? undefined
					: aggregateProwlarrStatistics(usableProwlarr),
		},
		lidarr: {
			instances: lidarrInstances,
			aggregate:
				!includeFailedInTotals && lidarrInstances.some((entry) => entry.error)
					? undefined
					: aggregateLidarrStatistics(usableLidarr),
		},
		readarr: {
			instances: readarrInstances,
			aggregate:
				!includeFailedInTotals && readarrInstances.some((entry) => entry.error)
					? undefined
					: aggregateReadarrStatistics(usableReadarr),
		},
		// Combined disk stats, de-duplicated across services + storage groups.
		// diskCount/instanceCount drive the transparency line in the UI so a
		// large total reads as "N disks across M instances", never a silent lie.
		combinedDisk: buildCombinedDiskPayload({
			sonarr: usableSonarr,
			radarr: usableRadarr,
			lidarr: usableLidarr,
			readarr: usableReadarr,
		}),
	};

	return {
		data: dashboardStatisticsResponseSchema.parse(payload),
		partial: fetchResults.some((result) => result?.error === true),
	};
}

/** Statistics-related routes for the dashboard. */
export const statisticsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/dashboard/statistics", async (request, reply) => {
		const { data } = await collectDashboardStatistics(app, request.currentUser!.id, request.log, {
			legacyTotals: true,
		});
		return reply.send(data);
	});

	app.get("/dashboard/statistics/snapshot", async (request, reply) => {
		const userId = request.currentUser!.id;
		const sources = await app.prisma.serviceInstance.findMany({
			where: { enabled: true, userId },
			select: { id: true, service: true, enabled: true, updatedAt: true },
		});
		const fingerprint = fingerprintDashboardSources(sources);
		let snapshot = await readDashboardSnapshot(app.prisma, userId, fingerprint, new Date());
		if (snapshot.refreshDue) {
			await requestDashboardStatisticsRefresh(app, userId, fingerprint, request.log, () =>
				collectDashboardStatistics(app, userId, request.log),
			);
			snapshot = await readDashboardSnapshot(app.prisma, userId, fingerprint, new Date());
		}
		return reply.send(
			dashboardStatisticsEnvelopeSchema.parse({
				availability: snapshot.availability,
				observedAt: snapshot.observedAt?.toISOString() ?? null,
				data: snapshot.data,
			}),
		);
	});

	done();
};
