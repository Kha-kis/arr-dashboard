import type { Prisma, ServiceInstance } from "../prisma.js";

export const isPositiveMonitoringId = (value: number): boolean =>
	Number.isSafeInteger(value) && value > 0;
export function isMonitoringResourceForTarget(
	value: unknown,
	id: number,
): value is Record<string, unknown> & { id: number } {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"id" in value &&
		value.id === id
	);
}
export type MonitoringSeason = Record<string, unknown> & {
	seasonNumber: number;
	monitored: boolean;
};
export function monitoringSeasons(value: unknown): MonitoringSeason[] | undefined {
	if (
		!Array.isArray(value) ||
		!value.every(
			(season) =>
				season !== null &&
				typeof season === "object" &&
				Number.isSafeInteger(season.seasonNumber) &&
				season.seasonNumber >= 0 &&
				typeof season.monitored === "boolean",
		) ||
		new Set(value.map((season) => season.seasonNumber)).size !== value.length
	)
		return undefined;
	return value;
}
export function isMonitoringStateConfirmed(
	value: unknown,
	expected: { id: number; monitored: boolean; seasons?: readonly MonitoringSeason[] },
): boolean {
	if (!isMonitoringResourceForTarget(value, expected.id) || value.monitored !== expected.monitored)
		return false;
	if (!expected.seasons) return true;
	const seasons = monitoringSeasons(value.seasons);
	return (
		seasons !== undefined &&
		expected.seasons.every((want) =>
			seasons.some(
				(actual) =>
					actual.seasonNumber === want.seasonNumber && actual.monitored === want.monitored,
			),
		)
	);
}
export function areRequestedMonitorRowsConfirmed(
	value: unknown,
	ids: readonly number[],
	parent: { key: "seriesId" | "artistId" | "authorId"; id: number },
	monitored?: boolean,
): boolean {
	if (!Array.isArray(value)) return false;
	return ids.every((id) => {
		const matches = value.filter((row) => isMonitoringResourceForTarget(row, id));
		const row = matches[0];
		return (
			matches.length === 1 &&
			row !== undefined &&
			row[parent.key] === parent.id &&
			typeof row.monitored === "boolean" &&
			(monitored === undefined || row.monitored === monitored)
		);
	});
}
// Current fields, not labels/updatedAt or remote-GUID/ABA history. Never log this predicate.
export function monitoringSourceWhere(instance: ServiceInstance): Prisma.ServiceInstanceWhereInput {
	return {
		id: instance.id,
		userId: instance.userId,
		service: instance.service,
		enabled: true,
		baseUrl: instance.baseUrl,
		encryptedApiKey: instance.encryptedApiKey,
		encryptionIv: instance.encryptionIv,
		encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
		httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	};
}
