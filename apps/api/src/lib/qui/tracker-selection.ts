import { createHmac } from "node:crypto";
import { type QuiTrackerView, quiTrackerHealthSchema } from "@arr/shared";
import type { Encryptor } from "../auth/encryption.js";
import { extractHostnameSafe } from "./client-helpers.js";

const TRACKER_SELECTOR_DOMAIN = "arr-dashboard:qui-tracker-selector:v1";
const UNAVAILABLE_TRACKER_LABEL = "Tracker unavailable";
const derivedKeys = new WeakMap<Encryptor, Buffer>();

export interface QuiTrackerSelectionScope {
	userId: string;
	serviceInstanceId: string;
	qbitInstanceId: number;
	hash: string;
}

export type QuiTrackerSelection =
	| { trackerSelectors: string[]; hostnames?: never }
	| { hostnames: string[]; trackerSelectors?: never };

export class QuiTrackerSelectionError extends Error {
	readonly code = "selection";

	constructor() {
		super("qUI tracker selection is stale, missing, duplicated, or ambiguous");
		this.name = "QuiTrackerSelectionError";
	}
}

function getSelectorKey(encryptor: Encryptor): Buffer {
	let key = derivedKeys.get(encryptor);
	if (!key) {
		key = Buffer.from(encryptor.fingerprint(TRACKER_SELECTOR_DOMAIN), "hex");
		derivedKeys.set(encryptor, key);
	}
	return key;
}

function getRawUrl(row: unknown): string | null {
	if (typeof row !== "object" || row === null || !("url" in row)) return null;
	return typeof row.url === "string" ? row.url : null;
}

function isPseudoUrl(url: string): boolean {
	return url.startsWith("** ");
}

function asInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function getViewBase(
	row: unknown,
	url: string,
): Omit<QuiTrackerView, "trackerSelector" | "selectable"> {
	const parsedUrl = (() => {
		try {
			return new URL(url);
		} catch {
			return null;
		}
	})();
	const hostname = extractHostnameSafe(url) || UNAVAILABLE_TRACKER_LABEL;
	const health =
		typeof row === "object" && row !== null && "health" in row
			? quiTrackerHealthSchema.safeParse(row.health)
			: null;
	const raw: Record<string, unknown> =
		typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
	const field = (name: string): unknown => (name in raw ? raw[name] : undefined);
	return {
		hostname,
		port: parsedUrl?.port || null,
		tier: asInteger(field("tier")),
		status: asInteger(field("status")) ?? 0,
		health: health?.success ? health.data : "unknown",
		numSeeds: asInteger(field("numSeeds")) ?? 0,
		numLeeches: asInteger(field("numLeeches")) ?? 0,
		numPeers: asInteger(field("numPeers")) ?? 0,
	};
}

function selectorFor(key: Buffer, scope: QuiTrackerSelectionScope, url: string): string {
	return createHmac("sha256", key)
		.update(
			JSON.stringify([
				TRACKER_SELECTOR_DOMAIN,
				scope.userId,
				scope.serviceInstanceId,
				scope.qbitInstanceId,
				scope.hash.toLowerCase(),
				url,
			]),
		)
		.digest("hex");
}

function getRealRows(trackers: readonly unknown[]) {
	return trackers.flatMap((row) => {
		const url = getRawUrl(row);
		return url === null || isPseudoUrl(url) ? [] : [{ row, url }];
	});
}

/** Build the privacy-safe drawer DTO without returning raw URLs or messages. */
export function projectQuiTrackerViews(
	encryptor: Encryptor,
	scope: QuiTrackerSelectionScope,
	trackers: readonly unknown[],
): QuiTrackerView[] {
	const key = getSelectorKey(encryptor);
	const rows = getRealRows(trackers);
	const urlCounts = new Map<string, number>();
	const labelCounts = new Map<string, number>();
	for (const { row, url } of rows) {
		urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
		const base = getViewBase(row, url);
		const label = JSON.stringify([base.hostname.toLowerCase(), base.port, base.tier]);
		labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
	}
	return rows.map(({ row, url }) => {
		const base = getViewBase(row, url);
		const label = JSON.stringify([base.hostname.toLowerCase(), base.port, base.tier]);
		const duplicateUrl = (urlCounts.get(url) ?? 0) > 1;
		const validUrl = base.hostname !== UNAVAILABLE_TRACKER_LABEL;
		return {
			...base,
			trackerSelector: duplicateUrl ? null : selectorFor(key, scope, url),
			selectable: validUrl && !duplicateUrl && (labelCounts.get(label) ?? 0) === 1,
		};
	});
}

/** Resolve every requested tracker against a fresh provider response. */
export function resolveQuiTrackerSelection(
	encryptor: Encryptor,
	scope: QuiTrackerSelectionScope,
	trackers: readonly unknown[],
	selection: QuiTrackerSelection,
): string[] {
	const hasSelectors = "trackerSelectors" in selection && selection.trackerSelectors !== undefined;
	const hasHostnames = "hostnames" in selection && selection.hostnames !== undefined;
	if (hasSelectors === hasHostnames) throw new QuiTrackerSelectionError();
	const rows = getRealRows(trackers);
	if (hasSelectors) {
		const selectors = selection.trackerSelectors;
		if (
			!Array.isArray(selectors) ||
			selectors.length < 1 ||
			selectors.length > 50 ||
			selectors.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) ||
			new Set(selectors).size !== selectors.length
		) {
			throw new QuiTrackerSelectionError();
		}
		const key = getSelectorKey(encryptor);
		const resolved = selectors.map((selector) => {
			const matches = rows.filter(({ url }) =>
				encryptor.safeCompare(selector, selectorFor(key, scope, url)),
			);
			if (matches.length !== 1) throw new QuiTrackerSelectionError();
			return matches[0]!.url;
		});
		if (new Set(resolved).size !== resolved.length) throw new QuiTrackerSelectionError();
		return resolved;
	}
	const hostnames = selection.hostnames;
	if (
		!Array.isArray(hostnames) ||
		hostnames.length < 1 ||
		hostnames.length > 50 ||
		hostnames.some((value) => typeof value !== "string" || value.length === 0) ||
		new Set(hostnames.map((hostname) => hostname.toLowerCase())).size !== hostnames.length
	) {
		throw new QuiTrackerSelectionError();
	}
	return hostnames.map((requestedHostname) => {
		const matches = rows.filter(
			({ url }) => extractHostnameSafe(url).toLowerCase() === requestedHostname.toLowerCase(),
		);
		if (matches.length !== 1) throw new QuiTrackerSelectionError();
		return matches[0]!.url;
	});
}
