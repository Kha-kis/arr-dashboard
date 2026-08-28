import type { PrismaClient, ServiceInstance } from "../prisma.js";

export const TAUTULLI_CACHE_FRESHNESS_MS = 12 * 60 * 60 * 1000;

export type TautulliCacheAuthorityReason =
	| "no_publication"
	| "instance_disabled"
	| "identity_unverified"
	| "refresh_in_progress"
	| "refresh_failed"
	| "credential_unavailable"
	| "provider_identity_changed"
	| "publication_superseded"
	| "no_supported_libraries"
	| "provider_response_invalid"
	| "legacy_error_redacted"
	| "cache_generation_stale"
	| "cache_rows_stale"
	| "cache_stale"
	| "tautulli_mapping_required"
	| "unknown_failure";

export type TautulliCacheAuthorityState =
	| "in_progress"
	| "failed_unavailable"
	| "healthy_complete"
	| "no_publication";

export interface TautulliCacheAuthorityProjection {
	available: boolean;
	state: TautulliCacheAuthorityState;
	reasonCodes: TautulliCacheAuthorityReason[];
	cachedItems: number;
	lastRefreshedAt: Date | null;
}

export interface TautulliSelectedCacheRow {
	id: string;
	instanceId: string;
	tmdbId: number;
	mediaType: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	watchedByUsers: string;
}

export interface TautulliSelectedCacheResult {
	configured: boolean;
	available: boolean;
	reasonCodes: TautulliCacheAuthorityReason[];
	rows: TautulliSelectedCacheRow[];
}

type TautulliAuthorityInstance = {
	service: string;
	enabled: boolean;
	expectedIdentity: string | null;
	identityStatus: string;
	connectionGeneration: number;
	identityGeneration: number;
};

type TautulliAuthorityStatus = {
	lastRefreshedAt: Date;
	lastResult: string;
	lastErrorMessage: string | null;
	itemCount: number;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptErrorMessage: string | null;
	connectionGeneration: number | null;
	identityGeneration: number | null;
};

const PERSISTABLE_REASON_CODES = new Set<TautulliCacheAuthorityReason>([
	"credential_unavailable",
	"provider_identity_changed",
	"publication_superseded",
	"no_supported_libraries",
	"provider_response_invalid",
	"cache_generation_stale",
	"cache_rows_stale",
	"cache_stale",
	"tautulli_mapping_required",
	"unknown_failure",
]);

function failed(
	reasonCodes: TautulliCacheAuthorityReason[],
	status: TautulliAuthorityStatus | null,
	state: TautulliCacheAuthorityState = "failed_unavailable",
): TautulliCacheAuthorityProjection {
	return {
		available: false,
		state,
		reasonCodes: [...new Set(reasonCodes)],
		cachedItems: 0,
		lastRefreshedAt: status?.lastRefreshedAt ?? null,
	};
}

function persistedFailureReason(message: string | null): TautulliCacheAuthorityReason {
	return message && PERSISTABLE_REASON_CODES.has(message as TautulliCacheAuthorityReason)
		? (message as TautulliCacheAuthorityReason)
		: "legacy_error_redacted";
}

export function evaluateTautulliCacheAuthority(
	instance: TautulliAuthorityInstance,
	status: TautulliAuthorityStatus | null,
	counts: { total: number; exact: number },
	options: { now?: Date; maxAgeMs?: number } = {},
): TautulliCacheAuthorityProjection {
	if (instance.service !== "TAUTULLI" || !instance.enabled) {
		return failed(["instance_disabled"], status);
	}
	if (instance.identityStatus !== "VERIFIED" || !instance.expectedIdentity) {
		return failed(["identity_unverified"], status);
	}
	if (!status) return failed(["no_publication"], null, "no_publication");
	if (status.lastAttemptResult?.startsWith("in_progress:")) {
		return failed(["refresh_in_progress"], status, "in_progress");
	}
	if (
		status.lastResult !== "success" ||
		status.lastAttemptResult !== "success" ||
		status.lastErrorMessage !== null ||
		status.lastAttemptErrorMessage !== null
	) {
		return failed(
			[
				"refresh_failed",
				persistedFailureReason(status.lastAttemptErrorMessage ?? status.lastErrorMessage),
			],
			status,
		);
	}
	if (
		status.connectionGeneration !== instance.connectionGeneration ||
		status.identityGeneration !== instance.identityGeneration ||
		status.lastAttemptAt?.getTime() !== status.lastRefreshedAt.getTime()
	) {
		return failed(["cache_generation_stale"], status);
	}
	if (counts.total !== counts.exact || counts.exact !== status.itemCount) {
		return failed(["cache_rows_stale"], status);
	}
	const now = options.now ?? new Date();
	const maxAgeMs = options.maxAgeMs ?? TAUTULLI_CACHE_FRESHNESS_MS;
	if (now.getTime() - status.lastRefreshedAt.getTime() > maxAgeMs) {
		return failed(["cache_stale"], status);
	}
	return {
		available: true,
		state: "healthy_complete",
		reasonCodes: [],
		cachedItems: counts.exact,
		lastRefreshedAt: status.lastRefreshedAt,
	};
}

export async function readOwnedTautulliCacheAuthority(
	prisma: PrismaClient,
	input: { userId: string; instanceId: string; now?: Date },
): Promise<TautulliCacheAuthorityProjection | null> {
	const instance = await prisma.serviceInstance.findFirst({
		where: { id: input.instanceId, userId: input.userId, service: "TAUTULLI" },
		select: {
			service: true,
			enabled: true,
			expectedIdentity: true,
			identityStatus: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (!instance) return null;

	const status = await prisma.cacheRefreshStatus.findFirst({
		where: {
			instanceId: input.instanceId,
			cacheType: "tautulli",
			instance: { userId: input.userId },
		},
	});
	const baseWhere = {
		instanceId: input.instanceId,
		instance: { userId: input.userId },
	};
	const [total, exact] = await Promise.all([
		prisma.tautulliCache.count({ where: baseWhere }),
		prisma.tautulliCache.count({
			where: {
				...baseWhere,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			},
		}),
	]);
	return evaluateTautulliCacheAuthority(instance, status, { total, exact }, { now: input.now });
}

export async function findOwnedEnabledTautulliInstance(
	prisma: PrismaClient,
	input: { userId: string; instanceId: string },
): Promise<ServiceInstance | null> {
	return await prisma.serviceInstance.findFirst({
		where: {
			id: input.instanceId,
			userId: input.userId,
			service: "TAUTULLI",
			enabled: true,
		},
	});
}

export async function readUserSelectedTautulliCache(
	prisma: PrismaClient,
	input: {
		userId: string;
		targets: Array<{ tmdbId: number; mediaType: "movie" | "series" }>;
		now?: Date;
		pageSize?: number;
	},
): Promise<TautulliSelectedCacheResult> {
	const instances = await prisma.serviceInstance.findMany({
		where: { userId: input.userId, service: "TAUTULLI", enabled: true },
		select: {
			id: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	if (instances.length === 0) {
		return { configured: false, available: true, reasonCodes: [], rows: [] };
	}
	if (instances.length !== 1) {
		return {
			configured: true,
			available: false,
			reasonCodes: ["tautulli_mapping_required"],
			rows: [],
		};
	}
	const instance = instances[0]!;
	const authority = await readOwnedTautulliCacheAuthority(prisma, {
		userId: input.userId,
		instanceId: instance.id,
		now: input.now,
	});
	if (!authority?.available) {
		return {
			configured: true,
			available: false,
			reasonCodes: authority?.reasonCodes ?? ["no_publication"],
			rows: [],
		};
	}
	if (input.targets.length === 0) {
		return { configured: true, available: true, reasonCodes: [], rows: [] };
	}

	const pageSize = Math.max(1, Math.min(input.pageSize ?? 500, 500));
	const rows: TautulliSelectedCacheRow[] = [];
	let cursor: string | undefined;
	while (rows.length < input.targets.length) {
		const page = await prisma.tautulliCache.findMany({
			where: {
				instanceId: instance.id,
				instance: { userId: input.userId },
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
				OR: input.targets.map((target) => ({
					tmdbId: target.tmdbId,
					mediaType: target.mediaType,
				})),
			},
			select: {
				id: true,
				instanceId: true,
				tmdbId: true,
				mediaType: true,
				lastWatchedAt: true,
				watchCount: true,
				watchedByUsers: true,
			},
			take: pageSize,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});
		if (page.length === 0) break;
		rows.push(...page);
		cursor = page[page.length - 1]!.id;
		if (page.length < pageSize) break;
	}
	return { configured: true, available: true, reasonCodes: [], rows };
}
