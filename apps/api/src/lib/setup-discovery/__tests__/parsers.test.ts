import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMediaBrowserUdpResponse, parsePlexGdmResponse } from "../parsers";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name));

describe("setup discovery datagram parsers", () => {
	it("parses a recorded Plex GDM response using the packet source address", () => {
		expect(
			parsePlexGdmResponse(fixture("plex-gdm-response.txt"), { address: "192.168.1.20" }),
		).toEqual({
			service: "plex",
			name: "Cinema Plex",
			baseUrl: "http://192.168.1.20:32400",
			serverId: "plex-server-123",
			protocol: "plex-gdm",
		});
	});

	it("parses Jellyfin and Emby JSON while replacing advertised hosts with packet sources", () => {
		expect(
			parseMediaBrowserUdpResponse("jellyfin", fixture("jellyfin-response.json"), {
				address: "192.168.1.40",
			}),
		).toMatchObject({
			service: "jellyfin",
			baseUrl: "http://192.168.1.40:8096",
			protocol: "jellyfin-udp",
		});
		expect(
			parseMediaBrowserUdpResponse("emby", fixture("emby-response.json"), {
				address: "192.168.1.50",
			}),
		).toMatchObject({
			service: "emby",
			baseUrl: "https://192.168.1.50:8920/emby",
			protocol: "emby-udp",
		});
	});

	it("rejects malformed, unrelated, and non-HTTP responses", () => {
		expect(parsePlexGdmResponse("HTTP/1.0 404 Nope", { address: "192.168.1.2" })).toBeNull();
		expect(
			parseMediaBrowserUdpResponse(
				"jellyfin",
				'{"Address":"ftp://192.168.1.2/media","Name":"Bad"}',
				{ address: "192.168.1.2" },
			),
		).toBeNull();
		expect(parseMediaBrowserUdpResponse("emby", "not-json", { address: "192.168.1.2" })).toBeNull();
	});

	it("strips credentials and tracking data from advertised addresses", () => {
		expect(
			parseMediaBrowserUdpResponse(
				"jellyfin",
				'{"Address":"http://user:secret@10.0.0.2:8096/jellyfin?token=secret#fragment","Name":"Jellyfin"}',
				{ address: "192.168.1.2" },
			),
		).toMatchObject({ baseUrl: "http://192.168.1.2:8096/jellyfin" });
	});
});
