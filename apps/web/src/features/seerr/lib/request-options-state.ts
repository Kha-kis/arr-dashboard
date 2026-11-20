import {
	type SeerrRequestOptions,
	type SeerrServerWithDetails,
	seerrServerWithDetailsSchema,
} from "@arr/shared";

export type RequestOptionsCoverage = SeerrRequestOptions["coverage"] | "unknown";

/** Retain only render-safe positives; invalid raw rows never establish coverage. */
export function getRequestOptionsState(options: unknown): {
	servers: SeerrServerWithDetails[];
	coverage: RequestOptionsCoverage;
} {
	if (
		!options ||
		typeof options !== "object" ||
		!("servers" in options) ||
		!Array.isArray(options.servers)
	) {
		return { servers: [], coverage: "unknown" };
	}
	const servers: SeerrServerWithDetails[] = [];
	for (const row of options.servers) {
		const result = seerrServerWithDetailsSchema.safeParse(row);
		if (result.success) servers.push(result.data);
	}
	if (
		servers.length !== options.servers.length ||
		!("configuredServerCount" in options) ||
		!("unavailableServerCount" in options) ||
		!("coverage" in options)
	)
		return { servers, coverage: "unknown" };
	const { configuredServerCount, unavailableServerCount, coverage } = options;
	if (
		typeof configuredServerCount !== "number" ||
		!Number.isInteger(configuredServerCount) ||
		configuredServerCount < 0 ||
		typeof unavailableServerCount !== "number" ||
		!Number.isInteger(unavailableServerCount) ||
		unavailableServerCount < 0 ||
		configuredServerCount !== servers.length + unavailableServerCount ||
		new Set(servers.map((s) => s.server.id)).size !== servers.length
	)
		return { servers, coverage: "unknown" };
	const expected =
		unavailableServerCount === 0 ? "complete" : servers.length > 0 ? "partial" : "unavailable";
	return { servers, coverage: coverage === expected ? expected : "unknown" };
}

/** An explicit missing identity must never become a default selection. */
export function resolveRequestOptionsServer(
	servers: SeerrServerWithDetails[],
	serverId: number | undefined,
	coverage: RequestOptionsCoverage,
): SeerrServerWithDetails | undefined {
	if (serverId !== undefined) return servers.find((s) => s.server.id === serverId);
	if (coverage !== "complete") return undefined;
	return servers.find((s) => s.server.isDefault) ?? servers[0];
}

/** Validate explicit choices and server defaults against the currently verified detail. */
export function hasVerifiedRequestOptions(
	server: SeerrServerWithDetails | undefined,
	profileId: number | undefined,
	rootFolder: string | undefined,
	tags: Iterable<number> = [],
): boolean {
	if (!server) return false;
	return (
		server.profiles.some((p) => p.id === (profileId ?? server.server.activeProfileId)) &&
		server.rootFolders.some((f) => f.path === (rootFolder ?? server.server.activeDirectory)) &&
		Array.from(tags).every((id) => server.tags.some((tag) => tag.id === id))
	);
}
