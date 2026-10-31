import type { ManualImportSubmissionFile } from "@arr/shared";
export interface RetainedImportAttempt {
	version: 1 | 2;
	idempotencyKey: string;
	selectionHash: string;
	importMode: "move" | "copy";
	remainderOf?: string;
}
/** Messages in this class are fixed local guidance, never provider/network text. */
export class ImportAttemptStorageError extends Error {}

export async function importScopeKey(binding: string): Promise<string> {
	return `arr-import-attempt:v1:${await digest(binding)}`;
}
async function digest(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Browser hashes bind retries locally; only the server can authorize file targets. */
export async function importSelectionHash(
	files: ManualImportSubmissionFile[],
	mode: "auto" | "move" | "copy",
	remainderOf?: string,
): Promise<string> {
	const identities = files
		.map((file) =>
			JSON.stringify([
				file.path,
				/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(file.downloadId)
					? file.downloadId.toLowerCase()
					: file.downloadId,
				...[
					"seriesId",
					"episodeIds",
					"episodeFileId",
					"movieId",
					"movieFileId",
					"artistId",
					"albumId",
					"albumReleaseId",
					"trackIds",
					"trackFileId",
					"authorId",
					"bookId",
					"bookFileId",
				].map((field) => {
					const value = file[field as keyof ManualImportSubmissionFile];
					return Array.isArray(value)
						? [...value].sort((a, b) => Number(a) - Number(b))
						: (value ?? null);
				}),
			]),
		)
		.sort();
	return digest(
		JSON.stringify([
			mode === "copy" ? "copy" : "move",
			identities,
			...(remainderOf === undefined ? [] : [remainderOf]),
		]),
	);
}

export function readImportAttempt(storageKey: string): RetainedImportAttempt | null {
	try {
		const value = sessionStorage.getItem(storageKey);
		if (value === null) return null;
		if (value.length > 2048) throw new Error();
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
		const record = parsed as Record<string, unknown>;
		if (
			!(
				(record.version === 1 &&
					Object.keys(record).length === 4 &&
					record.remainderOf === undefined) ||
				(record.version === 2 &&
					Object.keys(record).length === 5 &&
					typeof record.remainderOf === "string" &&
					record.remainderOf.length > 0 &&
					record.remainderOf.length <= 128 &&
					record.remainderOf === record.remainderOf.trim())
			) ||
			typeof record.idempotencyKey !== "string" ||
			record.idempotencyKey.length > 128 ||
			!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(record.idempotencyKey) ||
			typeof record.selectionHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(record.selectionHash) ||
			(record.importMode !== "move" && record.importMode !== "copy")
		)
			throw new Error();
		return {
			version: record.version,
			idempotencyKey: record.idempotencyKey,
			selectionHash: record.selectionHash,
			importMode: record.importMode,
			...(record.version === 2 ? { remainderOf: record.remainderOf as string } : {}),
		};
	} catch {
		throw new ImportAttemptStorageError(
			"Browser attempt storage is unavailable or inconsistent. No new import was requested. Check existing ARR activity before changing browser state.",
		);
	}
}

/** Explicit new intention only; storage never grants server-side replay authority. */
export function retainRemainingImportAttempt(
	storageKey: string,
	selectionHash: string,
	importMode: "move" | "copy",
	remainderOf: string,
	expectedPreviousKey: string | null,
): RetainedImportAttempt {
	const existing = readImportAttempt(storageKey);
	if (
		existing?.remainderOf === remainderOf &&
		existing.selectionHash === selectionHash &&
		existing.importMode === importMode &&
		existing.idempotencyKey !== expectedPreviousKey
	)
		return existing;
	if ((existing?.idempotencyKey ?? null) !== expectedPreviousKey)
		throw new ImportAttemptStorageError(
			"The retained attempt changed since review. Check its progress; no new import was requested.",
		);
	const attempt: RetainedImportAttempt = {
		version: 2,
		idempotencyKey: crypto.randomUUID(),
		selectionHash,
		importMode,
		remainderOf,
	};
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(attempt));
		if (readImportAttempt(storageKey)?.idempotencyKey !== attempt.idempotencyKey) throw new Error();
	} catch {
		throw new ImportAttemptStorageError(
			"Browser attempt storage is unavailable. No new import was requested; check existing progress before retrying.",
		);
	}
	return attempt;
}

export function retainImportAttempt(
	storageKey: string,
	selectionHash: string,
	importMode: "auto" | "move" | "copy",
): RetainedImportAttempt {
	const existing = readImportAttempt(storageKey);
	if (existing) {
		if (existing.selectionHash !== selectionHash)
			throw new ImportAttemptStorageError(
				"The selection differs from the retained attempt. Check its progress; do not retry it with changed files or mode.",
			);
		return existing;
	}
	const attempt: RetainedImportAttempt = {
		version: 1,
		idempotencyKey: crypto.randomUUID(),
		selectionHash,
		importMode: importMode === "copy" ? "copy" : "move",
	};
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(attempt));
		if (readImportAttempt(storageKey)?.idempotencyKey !== attempt.idempotencyKey) throw new Error();
	} catch {
		throw new ImportAttemptStorageError(
			"Browser attempt storage is unavailable. Enable session storage before importing; no new import was requested.",
		);
	}
	return attempt;
}

/** A deliberate new normal intention, not a replay or terminal remainder. */
export function retainNewImportAttempt(
	storageKey: string,
	selectionHash: string,
	importMode: "auto" | "move" | "copy",
	expectedPreviousKey: string | null,
): RetainedImportAttempt {
	const existing = readImportAttempt(storageKey);
	if ((existing?.idempotencyKey ?? null) !== expectedPreviousKey)
		throw new ImportAttemptStorageError(
			"The retained attempt changed since review. Check its progress; no new import was requested.",
		);
	const attempt: RetainedImportAttempt = {
		version: 1,
		idempotencyKey: crypto.randomUUID(),
		selectionHash,
		importMode: importMode === "copy" ? "copy" : "move",
	};
	try {
		sessionStorage.setItem(storageKey, JSON.stringify(attempt));
		if (readImportAttempt(storageKey)?.idempotencyKey !== attempt.idempotencyKey) throw new Error();
	} catch {
		throw new ImportAttemptStorageError(
			"Browser attempt storage is unavailable. No new import was requested; check existing progress before retrying.",
		);
	}
	return attempt;
}
