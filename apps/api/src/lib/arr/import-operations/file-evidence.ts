import type { ManualImportServiceType } from "@arr/shared";
import { normalizeDownloadId } from "../../queue-cleaner/qui-gate.js";
import { importCommandFingerprint } from "../manual-import-command.js";

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function source(value: unknown): string | null {
	if (typeof value !== "string" || !value || value !== value.trim()) return null;
	return normalizeDownloadId(value) ?? value;
}

function positiveId(value: unknown): number | null {
	if (typeof value !== "number" && !(typeof value === "string" && /^[1-9]\d*$/.test(value)))
		return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

const mediaFields: Record<ManualImportServiceType, readonly string[]> = {
	sonarr: ["seriesId"],
	radarr: ["movieId"],
	lidarr: ["artistId", "albumId"],
	readarr: ["authorId", "bookId"],
};
const importEvents: Record<ManualImportServiceType, string> = {
	sonarr: "downloadFolderImported",
	radarr: "downloadFolderImported",
	lidarr: "trackFileImported",
	readarr: "bookFileImported",
};

export interface ImportFileWitness {
	fileFingerprint: string;
	fileId: number;
	episodeIds: number[];
}
export interface ImportWitnessProgress {
	witnesses: ImportFileWitness[];
	ambiguousFiles: string[];
}

export class ImportEvidenceUnavailableError extends Error {
	constructor() {
		super("Import file evidence is unavailable or its continuation is invalid.");
		this.name = "ImportEvidenceUnavailableError";
	}
}

function selectedFileValid(
	service: ManualImportServiceType,
	file: Record<string, unknown>,
): boolean {
	return Boolean(
		importCommandFingerprint([file]) &&
			source(file.downloadId) &&
			mediaFields[service]?.every(
				(field) => typeof file[field] === "number" && positiveId(file[field]) !== null,
			) &&
			(service !== "sonarr" ||
				(Array.isArray(file.episodeIds) &&
					file.episodeIds.length > 0 &&
					file.episodeIds.every((id) => typeof id === "number" && positiveId(id) !== null) &&
					new Set(file.episodeIds).size === file.episodeIds.length)),
	);
}

function positiveWitness(
	service: ManualImportServiceType,
	file: Record<string, unknown>,
	raw: unknown,
	notBefore: Date,
	notAfter?: Date,
): { fileId: number; episodeId?: number } | null {
	const record = object(raw);
	const data = object(record?.data);
	if (
		!record ||
		!data ||
		record.eventType !== importEvents[service] ||
		typeof record.date !== "string" ||
		!Number.isFinite(Date.parse(record.date)) ||
		Date.parse(record.date) < notBefore.getTime() ||
		(notAfter !== undefined && Date.parse(record.date) > notAfter.getTime()) ||
		source(record.downloadId) !== source(file.downloadId) ||
		(data.droppedPath ?? data.DroppedPath) !== file.path ||
		mediaFields[service].some((field) => record[field] !== file[field])
	)
		return null;
	const fileId = positiveId(data.fileId ?? data.FileId);
	if (fileId === null) return null;
	if (service !== "sonarr") return { fileId };
	const episodeId = positiveId(record.episodeId);
	if (episodeId === null || !Array.isArray(file.episodeIds) || !file.episodeIds.includes(episodeId))
		return null;
	return { fileId, episodeId };
}

/** Preserve bounded positive coordinates across pages, never private History payloads. */
export function accumulatePositiveImportWitnesses(
	service: ManualImportServiceType,
	files: Array<Record<string, unknown>>,
	history: unknown[],
	notBefore: Date,
	notAfter: Date,
	previous: ImportWitnessProgress = { witnesses: [], ambiguousFiles: [] },
): ImportWitnessProgress {
	if (
		!Number.isFinite(notBefore.getTime()) ||
		!Number.isFinite(notAfter.getTime()) ||
		notAfter < notBefore ||
		!files.length ||
		files.length > 1000 ||
		history.length > 10_000 ||
		files.some((file) => !selectedFileValid(service, file)) ||
		!Array.isArray(previous.witnesses) ||
		!Array.isArray(previous.ambiguousFiles) ||
		previous.witnesses.length > 1000 ||
		previous.ambiguousFiles.length > 1000
	)
		throw new ImportEvidenceUnavailableError();
	const selected = new Map(files.map((file) => [importCommandFingerprint([file])!, file]));
	if (selected.size !== files.length) throw new ImportEvidenceUnavailableError();
	const ambiguous = new Set(previous.ambiguousFiles);
	if (
		ambiguous.size !== previous.ambiguousFiles.length ||
		[...ambiguous].some((fp) => !selected.has(fp))
	)
		throw new ImportEvidenceUnavailableError();
	const witnesses = new Map<string, ImportFileWitness>();
	for (const witness of previous.witnesses) {
		const file = selected.get(witness.fileFingerprint);
		if (
			!file ||
			ambiguous.has(witness.fileFingerprint) ||
			witnesses.has(witness.fileFingerprint) ||
			positiveId(witness.fileId) === null ||
			!Array.isArray(witness.episodeIds) ||
			new Set(witness.episodeIds).size !== witness.episodeIds.length ||
			witness.episodeIds.some(
				(id) =>
					positiveId(id) === null ||
					service !== "sonarr" ||
					!Array.isArray(file.episodeIds) ||
					!file.episodeIds.includes(id),
			)
		)
			throw new ImportEvidenceUnavailableError();
		witnesses.set(witness.fileFingerprint, { ...witness, episodeIds: [...witness.episodeIds] });
	}
	for (const [fileFingerprint, file] of selected) {
		if (ambiguous.has(fileFingerprint)) continue;
		for (const row of history) {
			const positive = positiveWitness(service, file, row, notBefore, notAfter);
			if (!positive) continue;
			const prior = witnesses.get(fileFingerprint);
			if (prior && prior.fileId !== positive.fileId) {
				witnesses.delete(fileFingerprint);
				ambiguous.add(fileFingerprint);
				break;
			}
			const witness = prior ?? { fileFingerprint, fileId: positive.fileId, episodeIds: [] };
			if (positive.episodeId !== undefined && !witness.episodeIds.includes(positive.episodeId))
				witness.episodeIds.push(positive.episodeId);
			witnesses.set(fileFingerprint, witness);
		}
	}
	if (
		[...witnesses.values()].reduce((count, witness) => count + witness.episodeIds.length, 0) >
		10_000
	)
		throw new ImportEvidenceUnavailableError();
	return {
		witnesses: [...witnesses.values()]
			.map((witness) => ({ ...witness, episodeIds: witness.episodeIds.sort((a, b) => a - b) }))
			.sort((a, b) => a.fileFingerprint.localeCompare(b.fileFingerprint)),
		ambiguousFiles: [...ambiguous].sort(),
	};
}

/** Merge only fully covered passes; pruning never retracts a prior positive fact. */
export function mergeCoveredImportWitnesses(
	service: ManualImportServiceType,
	files: Array<Record<string, unknown>>,
	notBefore: Date,
	notAfter: Date,
	previous: ImportWitnessProgress,
	covered: ImportWitnessProgress,
): ImportWitnessProgress {
	const prior = accumulatePositiveImportWitnesses(
		service,
		files,
		[],
		notBefore,
		notAfter,
		previous,
	);
	const next = accumulatePositiveImportWitnesses(service, files, [], notBefore, notAfter, covered);
	const ambiguous = new Set([...prior.ambiguousFiles, ...next.ambiguousFiles]);
	const witnesses = new Map(prior.witnesses.map((witness) => [witness.fileFingerprint, witness]));
	for (const witness of next.witnesses) {
		const old = witnesses.get(witness.fileFingerprint);
		if (old && old.fileId !== witness.fileId) ambiguous.add(witness.fileFingerprint);
		else
			witnesses.set(witness.fileFingerprint, {
				...witness,
				episodeIds: [...new Set([...(old?.episodeIds ?? []), ...witness.episodeIds])],
			});
	}
	for (const fingerprint of ambiguous) witnesses.delete(fingerprint);
	return accumulatePositiveImportWitnesses(service, files, [], notBefore, notAfter, {
		witnesses: [...witnesses.values()],
		ambiguousFiles: [...ambiguous],
	});
}

/** Call only after finishing the source's History coverage, not on a page prefix. */
export function verifiedImportWitnessFiles(
	service: ManualImportServiceType,
	files: Array<Record<string, unknown>>,
	progress: ImportWitnessProgress,
): string[] {
	const selected = new Map(files.map((file) => [importCommandFingerprint([file]), file]));
	return progress.witnesses
		.filter((witness) => {
			const file = selected.get(witness.fileFingerprint);
			return (
				file &&
				selectedFileValid(service, file) &&
				positiveId(witness.fileId) !== null &&
				!progress.ambiguousFiles.includes(witness.fileFingerprint) &&
				(service !== "sonarr" ||
					(Array.isArray(file.episodeIds) &&
						file.episodeIds.every((id) => witness.episodeIds.includes(id))))
			);
		})
		.map((witness) => witness.fileFingerprint);
}

/**
 * Returns positive file fingerprints only, never an absence/completion verdict.
 * Inputs are current, connection-bound command files and a bounded History page.
 * Callers persist positive proofs separately from aggregate command state.
 */
export function matchPositiveImportFiles(
	service: ManualImportServiceType,
	files: Array<Record<string, unknown>>,
	history: unknown[],
	notBefore: Date,
): string[] {
	if (
		!Number.isFinite(notBefore.getTime()) ||
		!files.length ||
		files.length > 1000 ||
		history.length > 10_000
	)
		return [];
	const verified: string[] = [];
	for (const file of files) {
		const fileFingerprint = importCommandFingerprint([file]);
		if (!fileFingerprint || !selectedFileValid(service, file)) continue;
		const episodeIds = file.episodeIds;
		if (
			service === "sonarr" &&
			(!Array.isArray(episodeIds) ||
				!episodeIds.length ||
				episodeIds.some((id) => typeof id !== "number" || positiveId(id) === null) ||
				new Set(episodeIds).size !== episodeIds.length)
		)
			continue;
		const importedIds = new Set<number>();
		const episodes = new Set<number>();
		for (const raw of history) {
			const positive = positiveWitness(service, file, raw, notBefore);
			if (!positive) continue;
			if (positive.episodeId !== undefined) episodes.add(positive.episodeId);
			importedIds.add(positive.fileId);
		}
		// Multiple file IDs for an exact source/path/media binding are ambiguous.
		if (importedIds.size !== 1) continue;
		if (
			service === "sonarr" &&
			(!Array.isArray(episodeIds) || !episodeIds.every((id) => episodes.has(id)))
		)
			continue;
		verified.push(fileFingerprint);
	}
	return [...new Set(verified)];
}
