import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { JellyfinClient } from "../jellyfin/jellyfin-client.js";
import { PlexClient } from "../plex/plex-client.js";
import { TautulliClient } from "../tautulli/tautulli-client.js";

const DISPLAY_FINGERPRINT_LENGTH = 12;

export type ProviderIdentityService = "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";

/** A service record already ownership-checked and decrypted by the caller. */
export interface DecryptedOwnedServiceSnapshot {
	service: ProviderIdentityService;
	baseUrl: string;
	apiKey: string;
	httpAuthHeaders?: Record<string, string>;
	label?: string | null;
}

/** Internal-only raw identity paired with safe-to-display derived values. */
export interface ProviderIdentityObservation {
	service: ProviderIdentityService;
	identityKind:
		| "plex-machine-identifier"
		| "jellyfin-server-id"
		| "emby-server-id"
		| "tautulli-pms-identifier";
	rawIdentity: string;
	confirmationDigest: string;
	fingerprint: string;
	displayName?: string;
}

export async function readProviderIdentity(
	instance: DecryptedOwnedServiceSnapshot,
	log: FastifyBaseLogger,
): Promise<ProviderIdentityObservation> {
	try {
		switch (instance.service) {
			case "PLEX": {
				const server = await new PlexClient(
					instance.baseUrl,
					instance.apiKey,
					log,
					undefined,
					instance.httpAuthHeaders,
				).getIdentity();
				return observe("PLEX", "plex-machine-identifier", server.machineIdentifier, instance.label);
			}
			case "JELLYFIN":
			case "EMBY": {
				if (
					instance.service === "JELLYFIN" &&
					Object.keys(instance.httpAuthHeaders ?? {}).length > 0
				) {
					throw new Error("Jellyfin HTTP Basic Auth is unsupported");
				}
				const server = await new JellyfinClient(
					instance.baseUrl,
					instance.apiKey,
					log,
					undefined,
					instance.httpAuthHeaders,
				).getServerInfo();
				return observe(
					instance.service,
					instance.service === "JELLYFIN" ? "jellyfin-server-id" : "emby-server-id",
					server.id,
					server.serverName,
				);
			}
			case "TAUTULLI": {
				const server = await new TautulliClient(
					instance.baseUrl,
					instance.apiKey,
					log,
					undefined,
					instance.httpAuthHeaders,
				).getServerIdentity();
				return observe(
					"TAUTULLI",
					"tautulli-pms-identifier",
					server.identifier,
					server.displayName,
				);
			}
		}
	} catch {
		// Credentials, URLs, and upstream identity values must not escape this boundary.
		throw new Error(`Unable to read ${instance.service} provider identity`);
	}
}

export function confirmProviderIdentity(expected: string, actual: string): boolean {
	if (!isSha256Digest(expected) || !isSha256Digest(actual)) return false;
	return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}

/** Stable derived identity used in persisted safety evidence without exposing the raw provider id. */
export function providerIdentityAuthorityFingerprint(input: {
	service: string;
	identityKind: string | null;
	expectedIdentity: string | null;
}): string {
	return digest(
		JSON.stringify({
			expectedIdentity: input.expectedIdentity,
			identityKind: input.identityKind,
			service: input.service,
		}),
	);
}

/** Stable per-record discriminator that does not persist the raw service instance id. */
export function providerInstanceAuthorityFingerprint(instanceId: string): string {
	return digest(JSON.stringify({ instanceId }));
}

function observe(
	service: ProviderIdentityService,
	identityKind: ProviderIdentityObservation["identityKind"],
	rawIdentity: string,
	displayName: string | null | undefined,
): ProviderIdentityObservation {
	const normalizedIdentity = rawIdentity.trim();
	if (!normalizedIdentity) throw new Error("provider identity missing");
	const confirmationDigest = digest(`${service}:${identityKind}:${normalizedIdentity}`);
	return {
		service,
		identityKind,
		rawIdentity: normalizedIdentity,
		confirmationDigest,
		fingerprint: digest(`display:${service}:${identityKind}:${normalizedIdentity}`).slice(
			0,
			DISPLAY_FINGERPRINT_LENGTH,
		),
		displayName: normalizeDisplayName(displayName),
	};
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isSha256Digest(value: string): boolean {
	return /^[a-f0-9]{64}$/i.test(value);
}

function normalizeDisplayName(value: string | null | undefined): string | undefined {
	const displayName = value?.trim();
	return displayName || undefined;
}
