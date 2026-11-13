import type { PlexNativeJobScope } from "../plex/plex-native-inventory.js";
import type { JellyfinNativeLibraryJobScope } from "../jellyfin/jellyfin-native-inventory.js";
import type { NativeInventoryJobUnavailable } from "./native-inventory-job-runner.js";

/** Two fixed read-only operations on exactly one stored connection. */
export type NativeControlWorkerInput = {
	baseUrl: string;
	apiKey: string;
	httpAuthHeaders?: Record<string, string>;
	deadlineAt: number;
	operation: "identity" | "discovery";
} & (
	| { provider: "plex"; workKey: "paired" }
	| { provider: "jellyfin"; workKey: "library" | "episode" }
);
export type NativeControlWorkerRequest = NativeControlWorkerInput & {
	version: 1;
	httpAuthHeaders: Record<string, string>;
	requestTimeoutMs: number;
};
export type NativeControlScope = PlexNativeJobScope | JellyfinNativeLibraryJobScope;
export type NativeControlDiscovery<Scope = NativeControlScope> =
	| { status: "ready"; catalogIdentity: string; scopes: Scope[] }
	| NativeInventoryJobUnavailable;
export type NativeControlSuccess<T extends NativeControlWorkerInput> = T extends {
	operation: "identity";
}
	? { status: "identity"; identity: string } | NativeInventoryJobUnavailable
	: NativeControlDiscovery<
			T extends { provider: "plex" } ? PlexNativeJobScope : JellyfinNativeLibraryJobScope
		>;
export type NativeControlWorkerResult =
	| { status: "identity"; identity: string }
	| NativeControlDiscovery
	| { status: "failed"; category: "invalid-request" | "provider-unavailable" };

function record(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const keys = Reflect.ownKeys(value);
	if (required.some((key) => !keys.includes(key))) return null;
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
			return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return null;
		result[key] = descriptor.value;
	}
	return result;
}
function key(value: unknown, max = Number.MAX_SAFE_INTEGER): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= max &&
		!value.includes("\0")
	);
}
function array(value: unknown): unknown[] | null {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > 20_000 ||
		Reflect.ownKeys(value).length !== length + 1
	)
		return null;
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (!descriptor || !("value" in descriptor)) return null;
		result.push(descriptor.value);
	}
	return result;
}

export function parseNativeControlWorkerRequest(value: unknown): NativeControlWorkerRequest | null {
	try {
		const input = record(value, [
			"version",
			"baseUrl",
			"apiKey",
			"httpAuthHeaders",
			"deadlineAt",
			"requestTimeoutMs",
			"operation",
			"provider",
			"workKey",
		]);
		if (
			input?.version !== 1 ||
			typeof input.baseUrl !== "string" ||
			!key(input.apiKey) ||
			!["http:", "https:"].includes(new URL(input.baseUrl).protocol) ||
			(input.operation !== "identity" && input.operation !== "discovery") ||
			(input.provider === "plex"
				? input.workKey !== "paired"
				: input.provider !== "jellyfin" ||
					(input.workKey !== "library" && input.workKey !== "episode")) ||
			typeof input.deadlineAt !== "number" ||
			!Number.isFinite(input.deadlineAt) ||
			typeof input.requestTimeoutMs !== "number" ||
			!Number.isSafeInteger(input.requestTimeoutMs) ||
			input.requestTimeoutMs < 1 ||
			input.requestTimeoutMs > 15_000
		)
			return null;
		if (typeof input.httpAuthHeaders !== "object" || input.httpAuthHeaders === null) return null;
		const keys = Reflect.ownKeys(input.httpAuthHeaders);
		if (keys.some((key) => typeof key !== "string")) return null;
		const headers = record(input.httpAuthHeaders, keys as string[]);
		if (!headers || Object.values(headers).some((value) => typeof value !== "string")) return null;
		return { ...input, httpAuthHeaders: { ...headers } } as NativeControlWorkerRequest;
	} catch {
		return null;
	}
}

export function parseNativeControlWorkerResult(
	value: unknown,
	input: Pick<NativeControlWorkerInput, "operation" | "provider" | "workKey">,
): NativeControlWorkerResult | null {
	try {
		const envelope = record(
			value,
			["status"],
			["category", "reason", "identity", "catalogIdentity", "scopes"],
		);
		if (!envelope) return null;
		if (envelope.status === "failed") {
			if (
				!record(value, ["status", "category"]) ||
				(envelope.category !== "invalid-request" && envelope.category !== "provider-unavailable")
			)
				return null;
			return { status: "failed", category: envelope.category };
		}
		if (envelope.status === "unavailable") {
			if (
				!record(value, ["status", "reason"]) ||
				(envelope.reason !== "deadline-exceeded" &&
					envelope.reason !== "provider-unavailable" &&
					envelope.reason !== "coverage-incomplete")
			)
				return null;
			return { status: "unavailable", reason: envelope.reason };
		}
		if (input.operation === "identity") {
			return envelope.status === "identity" &&
				record(value, ["status", "identity"]) &&
				key(envelope.identity)
				? { status: "identity", identity: envelope.identity }
				: null;
		}
		if (
			envelope.status !== "ready" ||
			!record(value, ["status", "catalogIdentity", "scopes"]) ||
			!(
				typeof envelope.catalogIdentity === "string" &&
				envelope.catalogIdentity.length > 0 &&
				envelope.catalogIdentity.length <= 8192 &&
				!envelope.catalogIdentity.includes("\0")
			)
		)
			return null;
		const raw = array(envelope.scopes);
		if (!raw) return null;
		const scopes: NativeControlScope[] = [];
		const seen = new Set<string>();
		const counts = { library: 0, episode: 0 };
		for (const entry of raw) {
			const scope =
				input.provider === "plex"
					? record(entry, ["domain", "sectionKey", "sectionUuid", "sectionType", "scopeKey"])
					: record(entry, ["libraryId", "collectionType", "scopeKey"]);
			if (!scope || !key(scope.scopeKey, 512)) return null;
			const domain = input.provider === "plex" ? scope.domain : input.workKey;
			if ((domain !== "library" && domain !== "episode") || ++counts[domain] > 10_000) return null;
			const identity = `${domain}\0${scope.scopeKey}`;
			if (seen.has(identity)) return null;
			seen.add(identity);
			if (input.provider === "plex") {
				if (
					!key(scope.sectionKey) ||
					!key(scope.sectionUuid) ||
					(scope.sectionType !== "movie" && scope.sectionType !== "show") ||
					(domain === "episode" && scope.sectionType !== "show") ||
					scope.scopeKey !==
						JSON.stringify([scope.sectionKey, scope.sectionUuid, scope.sectionType])
				)
					return null;
				scopes.push({
					domain,
					sectionKey: scope.sectionKey,
					sectionUuid: scope.sectionUuid,
					sectionType: scope.sectionType,
					scopeKey: scope.scopeKey,
				});
			} else {
				if (
					!key(scope.libraryId) ||
					typeof scope.collectionType !== "string" ||
					scope.scopeKey !== `library:${scope.libraryId}`
				)
					return null;
				scopes.push({
					libraryId: scope.libraryId,
					collectionType: scope.collectionType,
					scopeKey: scope.scopeKey,
				});
			}
		}
		return { status: "ready", catalogIdentity: envelope.catalogIdentity, scopes };
	} catch {
		return null;
	}
}
