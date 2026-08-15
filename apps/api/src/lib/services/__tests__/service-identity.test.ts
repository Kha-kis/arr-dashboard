import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	confirmProviderIdentity,
	type DecryptedOwnedServiceSnapshot,
	readProviderIdentity,
} from "../service-identity.js";

const log = { warn: vi.fn() } as never;

function snapshot(
	service: DecryptedOwnedServiceSnapshot["service"],
): DecryptedOwnedServiceSnapshot {
	return {
		service,
		baseUrl: "http://media.test",
		apiKey: "test-api-key",
		label: "Living Room",
	};
}

function response(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("readProviderIdentity", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("reads Plex machineIdentifier without exposing the raw identity in its fingerprint", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					MediaContainer: {
						machineIdentifier: "plex-machine-123",
						version: "1.0.0",
					},
				}),
			),
		);

		const observation = await readProviderIdentity(snapshot("PLEX"), log);

		expect(observation).toMatchObject({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "plex-machine-123",
			displayName: "Living Room",
		});
		expect(observation.confirmationDigest).toBe(
			createHash("sha256").update("PLEX:plex-machine-identifier:plex-machine-123").digest("hex"),
		);
		expect(observation.fingerprint).toMatch(/^[a-f0-9]{12}$/);
		expect(observation.fingerprint).not.toContain("plex-machine-123");
	});

	it("reads Jellyfin and Emby Id values through the existing server-info client", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(async () =>
				response({
					Id: "jellyfin-server-456",
					ServerName: "Media Server",
					Version: "10.9.0",
				}),
			),
		);

		const jellyfin = await readProviderIdentity(snapshot("JELLYFIN"), log);
		const emby = await readProviderIdentity(snapshot("EMBY"), log);

		expect(jellyfin).toMatchObject({
			service: "JELLYFIN",
			identityKind: "jellyfin-server-id",
			rawIdentity: "jellyfin-server-456",
			displayName: "Media Server",
		});
		expect(emby).toMatchObject({
			service: "EMBY",
			identityKind: "emby-server-id",
			rawIdentity: "jellyfin-server-456",
		});
	});

	it("reads Tautulli pms_identifier as its primary identity", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					response: {
						result: "success",
						message: null,
						data: { pms_identifier: "tautulli-pms-789", pms_name: "Plex Monitor" },
					},
				}),
			),
		);

		const observation = await readProviderIdentity(snapshot("TAUTULLI"), log);

		expect(observation).toMatchObject({
			service: "TAUTULLI",
			identityKind: "tautulli-pms-identifier",
			rawIdentity: "tautulli-pms-789",
			displayName: "Plex Monitor",
		});
	});

	it("uses constant-time comparison for equal and different confirmation digests", () => {
		const digest = createHash("sha256").update("identity").digest("hex");
		expect(confirmProviderIdentity(digest, digest)).toBe(true);
		expect(confirmProviderIdentity(digest, "0".repeat(64))).toBe(false);
		expect(confirmProviderIdentity(digest, "not-a-digest")).toBe(false);
	});

	it("sanitizes upstream identity and credentials from public reader errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("http://user:pass@media.test?token=secret")),
		);

		await expect(readProviderIdentity(snapshot("PLEX"), log)).rejects.toThrow(
			"Unable to read PLEX provider identity",
		);
		await expect(readProviderIdentity(snapshot("PLEX"), log)).rejects.not.toThrow(
			/user:pass|secret|test-api-key/,
		);
	});

	it("keeps Jellyfin Basic Auth credentials out of reader errors", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const instance = snapshot("JELLYFIN");
		instance.httpAuthHeaders = { Authorization: "Basic dXNlcjpwYXNz" };

		await expect(readProviderIdentity(instance, log)).rejects.toThrow(
			"Unable to read JELLYFIN provider identity",
		);
		await expect(readProviderIdentity(instance, log)).rejects.not.toThrow(
			/Basic|dXNlcjpwYXNz|user:pass/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
