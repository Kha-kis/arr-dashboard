import { createHash } from "node:crypto";
import { manualImportForeignEditionIdSchema } from "@arr/shared";
import type { QueueCapableClient } from "./client-factory.js";

export interface ManualImportCommandOutcome {
	commandId?: number;
	state: "pending" | "completed" | "failed" | "unknown";
}

/** Bind a command receipt to the exact verified files and media, not its display name. */
export function importCommandFingerprint(files: unknown): string | null {
	if (!Array.isArray(files) || files.length === 0) return null;
	const signatures: string[] = [];
	for (const raw of files) {
		if (!raw || typeof raw !== "object") return null;
		const file = raw as Record<string, unknown>;
		if (
			typeof file.path !== "string" ||
			!file.path ||
			typeof file.downloadId !== "string" ||
			!file.downloadId
		)
			return null;
		const identity: Record<string, unknown> = {
			path: file.path,
			downloadId: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(file.downloadId)
				? file.downloadId.toLowerCase()
				: file.downloadId,
		};
		for (const field of [
			"movieId",
			"seriesId",
			"artistId",
			"albumId",
			"authorId",
			"bookId",
			"episodeFileId",
			"movieFileId",
			"albumReleaseId",
			"trackFileId",
			"bookFileId",
		] as const) {
			const value = file[field];
			if (
				value !== undefined &&
				value !== null &&
				(!Number.isSafeInteger(value) || Number(value) < 0)
			)
				return null;
			identity[field] = value ?? null;
		}
		for (const field of ["episodeIds", "trackIds"] as const) {
			const values = file[field];
			if (
				values !== undefined &&
				(!Array.isArray(values) ||
					values.some((value) => !Number.isSafeInteger(value) || value <= 0))
			)
				return null;
			identity[field] = Array.isArray(values) ? [...values].sort((a, b) => a - b) : null;
		}
		// Preserve legacy v1 bindings, including typed command bodies that emit null.
		if (file.foreignEditionId !== undefined && file.foreignEditionId !== null) {
			const edition = manualImportForeignEditionIdSchema.safeParse(file.foreignEditionId);
			if (!edition.success) return null;
			identity.foreignEditionId = edition.data;
		}
		signatures.push(JSON.stringify(identity));
	}
	return `v1:${createHash("sha256").update(JSON.stringify(signatures.sort())).digest("hex")}`;
}

export function classifyImportCommand(
	value: unknown,
	expectedFingerprint: string | null,
	expectedId?: number,
): ManualImportCommandOutcome {
	if (!value || typeof value !== "object") return { state: "unknown" };
	const command = value as Record<string, unknown>;
	const id = command.id;
	if (
		!Number.isSafeInteger(id) ||
		Number(id) <= 0 ||
		(expectedId !== undefined && id !== expectedId)
	)
		return { state: "unknown" };
	const commandId = Number(id);
	const body =
		command.body && typeof command.body === "object"
			? (command.body as Record<string, unknown>)
			: undefined;
	if ((command.name ?? command.commandName ?? body?.name) !== "ManualImport")
		return { commandId, state: "unknown" };
	// Pending is never mutation permission. Terminal results require the persisted file receipt.
	if (command.status === "queued" || command.status === "started")
		return { commandId, state: "pending" };
	if (!expectedFingerprint || importCommandFingerprint(body?.files) !== expectedFingerprint)
		return { commandId, state: "unknown" };
	if (command.status === "completed" && command.result === "successful")
		return { commandId, state: "completed" };
	if (
		["failed", "aborted", "cancelled", "orphaned"].includes(String(command.status)) ||
		(command.status === "completed" && command.result === "unsuccessful")
	)
		return { commandId, state: "failed" };
	return { commandId, state: "unknown" };
}

export async function readImportCommandOutcome(
	client: QueueCapableClient,
	service: string,
	commandId: number | null,
	fingerprint: string | null,
	notBefore: Date | null,
): Promise<ManualImportCommandOutcome> {
	try {
		const version = service === "lidarr" || service === "readarr" ? "v1" : "v3";
		if (commandId === null) {
			if (!fingerprint || !notBefore || !Number.isFinite(notBefore.getTime()))
				return { state: "unknown" };
			const commands = await client.get<unknown>(`/api/${version}/command`);
			if (!Array.isArray(commands) || commands.length > 1000) return { state: "unknown" };
			const matches = commands.filter((raw) => {
				if (!raw || typeof raw !== "object") return false;
				const command = raw as Record<string, unknown>;
				const body = command.body as Record<string, unknown> | undefined;
				return (
					command.name === "ManualImport" &&
					Number.isSafeInteger(command.id) &&
					Number(command.id) > 0 &&
					typeof command.queued === "string" &&
					Date.parse(command.queued) >= notBefore.getTime() &&
					importCommandFingerprint(body?.files) === fingerprint
				);
			});
			// Absence is not proof that the POST failed; never resubmit on that basis.
			if (matches.length !== 1) return { state: "unknown" };
			commandId = Number(matches[0].id);
		}
		const receipt = await client.get(`/api/${version}/command/${commandId}`);
		const outcome = classifyImportCommand(receipt, fingerprint, commandId);
		if (outcome.state !== "completed" && outcome.state !== "failed") return outcome;
		// Command success alone does not prove that every file imported. Match positive
		// history to the same download, source path, media and this attempt's time.
		if (!notBefore || !Number.isFinite(notBefore.getTime())) return { commandId, state: "unknown" };
		const body = (receipt as { body: { files: Array<Record<string, unknown>> } }).body;
		const downloads = new Set(body.files.map((file) => file.downloadId));
		if (downloads.size !== 1) return { commandId, state: "unknown" };
		const page = await client.get<Record<string, unknown>>(`/api/${version}/history`, {
			downloadId: body.files[0]!.downloadId as string,
			page: 1,
			pageSize: 1000,
			sortKey: "date",
			sortDirection: "descending",
		});
		if (
			!page ||
			!Array.isArray(page.records) ||
			page.records.length > 1000 ||
			!Number.isSafeInteger(page.totalRecords) ||
			Number(page.totalRecords) < page.records.length
		)
			return { commandId, state: "unknown" };
		const importEvent =
			service === "lidarr"
				? "trackFileImported"
				: service === "readarr"
					? "bookFileImported"
					: "downloadFolderImported";
		const records = page.records.filter((raw): raw is Record<string, unknown> => {
			if (!raw || typeof raw !== "object") return false;
			const record = raw as Record<string, unknown>;
			return (
				record.eventType === importEvent &&
				typeof record.date === "string" &&
				Date.parse(record.date) >= notBefore.getTime()
			);
		});
		const verified = body.files.every((file) => {
			const matches = records.filter((record) => {
				const data = record.data as Record<string, unknown> | undefined;
				const path = data?.droppedPath ?? data?.DroppedPath;
				const fileId = data?.fileId ?? data?.FileId;
				return (
					record.downloadId === file.downloadId &&
					path === file.path &&
					((typeof fileId === "string" && /^[1-9]\d*$/.test(fileId)) ||
						(Number.isSafeInteger(fileId) && Number(fileId) > 0))
				);
			});
			if (service === "sonarr")
				return (
					Array.isArray(file.episodeIds) &&
					file.episodeIds.length > 0 &&
					file.episodeIds.every((id) =>
						matches.some((record) => record.seriesId === file.seriesId && record.episodeId === id),
					)
				);
			const fields =
				service === "radarr"
					? ["movieId"]
					: service === "lidarr"
						? ["artistId", "albumId"]
						: service === "readarr"
							? ["authorId", "bookId"]
							: [];
			return (
				fields.length > 0 &&
				fields.every((field) => Number.isSafeInteger(file[field]) && Number(file[field]) > 0) &&
				matches.some((record) => fields.every((field) => record[field] === file[field]))
			);
		});
		return verified
			? { commandId, state: "completed" }
			: outcome.state === "failed"
				? outcome
				: { commandId, state: "unknown" };
	} catch {
		return { ...(commandId === null ? {} : { commandId }), state: "unknown" };
	}
}
