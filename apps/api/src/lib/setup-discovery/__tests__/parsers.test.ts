import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	parseMediaBrowserUdpResponse,
	parsePlexGdmResponse,
	parsePlexSsdpResponse,
} from "../parsers";

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

	it("parses a Plex SSDP response into the Plex HTTP endpoint", () => {
		expect(
			parsePlexSsdpResponse(fixture("plex-ssdp-response.txt"), { address: "192.168.1.20" }),
		).toEqual({
			service: "plex",
			name: "Plex Media Server",
			baseUrl: "http://192.168.1.20:32400",
			serverId: "2b95f4f3-0e2d-4ee4-a05d-3c7eaf30d990",
			protocol: "plex-ssdp",
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
			parsePlexSsdpResponse(
				"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\nLOCATION: http://192.168.1.2:8200/description.xml\r\nUSN: uuid:not-plex::urn:schemas-upnp-org:device:MediaServer:1",
				{ address: "192.168.1.2" },
			),
		).toBeNull();
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
