import { describe, expect, it } from "vitest";
import { setupDiscoveryCandidateSchema, setupDiscoveryResponseSchema } from "../setup-discovery";

describe("setup discovery contracts", () => {
	it("accepts a credential-free media-server candidate", () => {
		expect(
			setupDiscoveryCandidateSchema.parse({
				service: "plex",
				name: "Living Room Plex",
				baseUrl: "http://192.168.1.10:32400",
				serverId: "plex-id",
				protocol: "plex-gdm",
			}),
		).toMatchObject({ service: "plex", protocol: "plex-gdm" });
	});

	it("accepts Plex SSDP as a discovery fallback", () => {
		expect(
			setupDiscoveryCandidateSchema.parse({
				service: "plex",
				name: "Plex Media Server",
				baseUrl: "http://192.168.1.10:32400",
				serverId: "plex-dlna-id",
				protocol: "plex-ssdp",
			}),
		).toMatchObject({ service: "plex", protocol: "plex-ssdp" });
	});

	it("rejects unsupported services and non-HTTP URLs", () => {
		expect(
			setupDiscoveryCandidateSchema.safeParse({
				service: "sonarr",
				name: "Sonarr",
				baseUrl: "not-a-url",
				serverId: null,
				protocol: "jellyfin-udp",
			}).success,
		).toBe(false);
	});

	it("rejects candidates that leak credentials or tokens through their URL", () => {
		expect(
			setupDiscoveryCandidateSchema.safeParse({
				service: "jellyfin",
				name: "Jellyfin",
				baseUrl: "http://user:secret@192.168.1.10:8096?token=secret",
				serverId: null,
				protocol: "jellyfin-udp",
			}).success,
		).toBe(false);
	});

	it("pins the response metadata used by the guided setup UI", () => {
		expect(
			setupDiscoveryResponseSchema.parse({
				candidates: [],
				scannedProtocols: ["plex-gdm", "plex-ssdp", "jellyfin-udp", "emby-udp"],
				durationMs: 1200,
			}),
		).toMatchObject({ candidates: [], durationMs: 1200 });
	});
});
