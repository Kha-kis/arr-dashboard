export type NativeWatchStageRow = {
	userKeyDigest: string;
	libraryId: string;
	jellyfinId: string;
	seriesId: string;
	seasonNumber: number;
	episodeNumber: number;
	played: boolean;
	playCount: number | null;
	lastPlayedAt: Date | null;
};

export type NativeWatchCandidate = NativeWatchStageRow;

export type NativeWatchProjectionDiagnostics = {
	invalidCollectRows: number;
	invalidVerifyRows: number;
	conflictedCoordinates: number;
	duplicateCollectCoordinates: number;
	missingVerifyCoordinates: number;
	duplicateVerifyCoordinates: number;
	changedObservationCoordinates: number;
	verifyOnlyCoordinates: number;
};

export type NativeWatchScopedProjectionDiagnostics = {
	userKeyDigest: string;
	libraryId: string;
	diagnostics: NativeWatchProjectionDiagnostics;
};

export function emptyNativeWatchProjectionDiagnostics(): NativeWatchProjectionDiagnostics {
	return {
		invalidCollectRows: 0,
		invalidVerifyRows: 0,
		conflictedCoordinates: 0,
		duplicateCollectCoordinates: 0,
		missingVerifyCoordinates: 0,
		duplicateVerifyCoordinates: 0,
		changedObservationCoordinates: 0,
		verifyOnlyCoordinates: 0,
	};
}

function validNativeWatchRow(row: NativeWatchStageRow): boolean {
	return (
		[row.userKeyDigest, row.libraryId, row.jellyfinId, row.seriesId].every(
			(value) => value.trim() !== "" && !value.includes("\0"),
		) &&
		Number.isSafeInteger(row.seasonNumber) &&
		row.seasonNumber >= 0 &&
		Number.isSafeInteger(row.episodeNumber) &&
		row.episodeNumber >= 0 &&
		typeof row.played === "boolean" &&
		(row.playCount === null || (Number.isSafeInteger(row.playCount) && row.playCount >= 0)) &&
		(row.lastPlayedAt === null ||
			(row.lastPlayedAt instanceof Date && Number.isFinite(row.lastPlayedAt.getTime())))
	);
}

function coordinateKey(row: NativeWatchStageRow): string {
	return `${row.userKeyDigest}\0${row.libraryId}\0${row.jellyfinId}`;
}

function nativeIdentityKey(row: NativeWatchStageRow): string {
	return `${row.seriesId}\0${row.seasonNumber}\0${row.episodeNumber}`;
}

function sameObservation(left: NativeWatchStageRow, right: NativeWatchStageRow): boolean {
	return (
		nativeIdentityKey(left) === nativeIdentityKey(right) &&
		left.played === right.played &&
		left.playCount === right.playCount &&
		left.lastPlayedAt?.getTime() === right.lastPlayedAt?.getTime()
	);
}

export function deriveNativeWatchCandidates(
	collect: readonly NativeWatchStageRow[],
	verify: readonly NativeWatchStageRow[],
	reportDiagnostics?: (diagnostics: NativeWatchProjectionDiagnostics) => void,
	reportScopeDiagnostics?: (scopes: readonly NativeWatchScopedProjectionDiagnostics[]) => void,
): NativeWatchCandidate[] {
	const diagnostics: NativeWatchProjectionDiagnostics = {
		invalidCollectRows: 0,
		invalidVerifyRows: 0,
		conflictedCoordinates: 0,
		duplicateCollectCoordinates: 0,
		missingVerifyCoordinates: 0,
		duplicateVerifyCoordinates: 0,
		changedObservationCoordinates: 0,
		verifyOnlyCoordinates: 0,
	};
	const scopes = new Map<string, NativeWatchScopedProjectionDiagnostics>();
	const scopeFor = (row: NativeWatchStageRow) => {
		const key = JSON.stringify([row.userKeyDigest, row.libraryId]);
		let scope = scopes.get(key);
		if (!scope) {
			scope = {
				userKeyDigest: row.userKeyDigest,
				libraryId: row.libraryId,
				diagnostics: emptyNativeWatchProjectionDiagnostics(),
			};
			scopes.set(key, scope);
		}
		return scope;
	};
	const increment = (row: NativeWatchStageRow, field: keyof NativeWatchProjectionDiagnostics) => {
		diagnostics[field]++;
		scopeFor(row).diagnostics[field]++;
	};
	const sourceIdentityById = new Map<string, string>();
	const conflictedIds = new Set<string>();
	const bucket = (rows: readonly NativeWatchStageRow[], pass: "collect" | "verify") => {
		// Keep the first row for identity diagnostics, but never retain a separate
		// array per coordinate. Any second row makes that coordinate ambiguous.
		const byKey = new Map<string, NativeWatchStageRow>();
		const duplicates = new Set<string>();
		for (const row of rows) {
			scopeFor(row);
			if (!validNativeWatchRow(row)) {
				increment(row, pass === "collect" ? "invalidCollectRows" : "invalidVerifyRows");
				conflictedIds.add(row.jellyfinId);
				continue;
			}
			const identity = nativeIdentityKey(row);
			const prior = sourceIdentityById.get(row.jellyfinId);
			if (prior !== undefined && prior !== identity) conflictedIds.add(row.jellyfinId);
			sourceIdentityById.set(row.jellyfinId, identity);
			const key = coordinateKey(row);
			if (byKey.has(key)) duplicates.add(key);
			else byKey.set(key, row);
		}
		return { byKey, duplicates };
	};
	const collected = bucket(collect, "collect");
	const verified = bucket(verify, "verify");
	const candidates: NativeWatchCandidate[] = [];
	for (const [key, row] of collected.byKey) {
		const verifyRow = verified.byKey.get(key);
		if (conflictedIds.has(row.jellyfinId)) increment(row, "conflictedCoordinates");
		else if (collected.duplicates.has(key)) increment(row, "duplicateCollectCoordinates");
		else if (!verifyRow) increment(row, "missingVerifyCoordinates");
		else if (verified.duplicates.has(key)) increment(row, "duplicateVerifyCoordinates");
		else if (!sameObservation(row, verifyRow)) increment(row, "changedObservationCoordinates");
		else candidates.push(row);
	}
	for (const [key, row] of verified.byKey) {
		if (!collected.byKey.has(key)) increment(row, "verifyOnlyCoordinates");
	}
	try {
		reportDiagnostics?.(diagnostics);
	} catch {
		// Numeric-only diagnostics cannot interrupt an otherwise valid projection.
	}
	try {
		reportScopeDiagnostics?.([...scopes.values()]);
	} catch {
		// Scope diagnostics are independent of aggregate reporting and candidates.
	}
	return candidates.sort((left, right) => {
		const a = coordinateKey(left);
		const b = coordinateKey(right);
		return a < b ? -1 : a > b ? 1 : 0;
	});
}
