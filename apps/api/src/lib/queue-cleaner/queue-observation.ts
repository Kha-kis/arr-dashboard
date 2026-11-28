import { createHash } from "node:crypto";
import type { QueueCapableClient } from "../arr/client-factory.js";
import { type RawQueueItem, rawQueueItemSchema } from "./queue-item-utils.js";
import { normalizeDownloadId } from "./qui-gate.js";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

type ObservedQueueItem = RawQueueItem & { id: number };

function parseItem(value: unknown): ObservedQueueItem {
	const parsed = rawQueueItemSchema.safeParse(value);
	if (!parsed.success || !Number.isSafeInteger(parsed.data.id) || Number(parsed.data.id) <= 0) {
		throw new Error("Queue observation has an invalid item identity; cleanup deferred.");
	}
	return parsed.data as ObservedQueueItem;
}

/** Reject partial/ambiguous observations before they can authorize strikes or cleanup. */
export async function readCompleteQueue(
	client: QueueCapableClient,
	service: string,
): Promise<ObservedQueueItem[]> {
	const records: ObservedQueueItem[] = [];
	await readWitnessedQueue(client, service, (item) => records.push(item));
	return records;
}

async function readWitnessedQueue(
	client: QueueCapableClient,
	service: string,
	collect: (item: ObservedQueueItem) => void,
): Promise<void> {
	const firstIdentities: Array<[number, string | null]> = [];
	await visitQueuePass(client, service, (item) => {
		firstIdentities.push([item.id, queueItemFingerprint(item)]);
	});
	let position = 0;
	let changed = false;
	// Finish the second pass even after a mismatch so every page still gets validated.
	await visitQueuePass(client, service, (item) => {
		const identity = firstIdentities[position++];
		const fingerprint = queueItemFingerprint(item);
		if (identity?.[0] !== item.id || identity[1] !== fingerprint) changed = true;
		collect(item);
	});
	if (changed || position !== firstIdentities.length)
		throw new Error("Queue changed between observations; cleanup deferred.");
}

async function visitQueuePass(
	client: QueueCapableClient,
	service: string,
	visit: (item: ObservedQueueItem) => void,
): Promise<void> {
	const ids = new Set<number>();
	let expectedTotal: number | undefined;
	let expectedPageSize: number | undefined;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const raw: unknown = await client.queue.get({
			page,
			pageSize: PAGE_SIZE,
			sortKey: "id",
			sortDirection: "ascending",
			...(service === "RADARR" ? { includeUnknownMovieItems: true } : {}),
		});
		if (!raw || typeof raw !== "object") throw new Error("Queue pagination is unavailable.");
		const envelope = raw as Record<string, unknown>;
		const { totalRecords, pageSize } = envelope;
		if (
			!Array.isArray(envelope.records) ||
			!Number.isSafeInteger(totalRecords) ||
			Number(totalRecords) < 0 ||
			!Number.isSafeInteger(pageSize) ||
			Number(pageSize) <= 0 ||
			Number(pageSize) > PAGE_SIZE ||
			envelope.page !== page
		)
			throw new Error("Queue pagination is invalid or incomplete; cleanup deferred.");
		const total = Number(totalRecords);
		const size = Number(pageSize);
		if (total > size * MAX_PAGES)
			throw new Error("Queue exceeds the bounded observation limit; cleanup deferred.");
		if (
			(expectedTotal !== undefined && expectedTotal !== total) ||
			(expectedPageSize !== undefined && expectedPageSize !== size)
		) {
			throw new Error("Queue changed during pagination; cleanup deferred.");
		}
		expectedTotal = total;
		expectedPageSize = size;
		if (envelope.records.length !== Math.min(size, total - ids.size)) {
			throw new Error("Queue page is truncated or inconsistent; cleanup deferred.");
		}
		for (const value of envelope.records) {
			const item = parseItem(value);
			if (ids.has(item.id)) throw new Error("Queue pages overlap; cleanup deferred.");
			ids.add(item.id);
			visit(item);
		}
		if (ids.size === total) return;
	}
	throw new Error("Queue observation did not complete; cleanup deferred.");
}

/** ARR queue IDs can be reused. This is identity evidence, never a display-title match. */
export function queueItemFingerprint(item: RawQueueItem): string | null {
	if (
		!Number.isSafeInteger(item.id) ||
		Number(item.id) <= 0 ||
		typeof item.downloadId !== "string" ||
		!item.downloadId.trim()
	)
		return null;
	const identity: Record<string, unknown> = {
		id: item.id,
		downloadId: normalizeDownloadId(item.downloadId) ?? item.downloadId,
		protocol: typeof item.protocol === "string" ? item.protocol.toLowerCase() : "unknown",
	};
	if (
		item.seasonNumber !== undefined &&
		item.seasonNumber !== null &&
		(!Number.isSafeInteger(item.seasonNumber) || Number(item.seasonNumber) < 0)
	)
		return null;
	identity.seasonNumber = item.seasonNumber ?? null;
	for (const field of [
		"movieId",
		"seriesId",
		"episodeId",
		"artistId",
		"albumId",
		"authorId",
		"bookId",
		"downloadClientId",
	] as const) {
		const value = item[field];
		if (
			value !== undefined &&
			value !== null &&
			(!Number.isSafeInteger(value) || Number(value) <= 0)
		)
			return null;
		identity[field] = value ?? null;
	}
	return `v1:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export async function readCurrentQueueItem(
	client: QueueCapableClient,
	service: string,
	id: number,
): Promise<RawQueueItem | undefined> {
	// These providers expose a complete queue list and no supported single-item GET.
	if (service === "LIDARR" || service === "SONARR" || service === "RADARR") {
		let target: ObservedQueueItem | undefined;
		await readWitnessedQueue(client, service, (item) => {
			if (item.id === id) target = item;
		});
		return target;
	}
	const queue = client.queue as { getById(id: number): Promise<unknown> };
	const item = parseItem(await queue.getById(id));
	if (item.id !== id) throw new Error("Queue target identity changed; cleanup deferred.");
	return item;
}
