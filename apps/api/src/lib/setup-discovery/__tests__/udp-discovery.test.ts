import type { Socket } from "node:dgram";
import { describe, expect, it } from "vitest";
import {
	deduplicateCandidates,
	discoverMediaServers,
	SETUP_DISCOVERY_PROTOCOLS,
} from "../udp-discovery";

type Handler = (...args: never[]) => void;

function respondingSocketFactory(): () => Socket {
	return () => {
		const handlers = new Map<string, Handler[]>();
		const socket = {
			on(event: string, handler: Handler) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				return socket;
			},
			bind(_port: number, _host: string, callback: () => void) {
				queueMicrotask(callback);
				return socket;
			},
			setBroadcast() {
				return socket;
			},
			setMulticastTTL() {
				return socket;
			},
			send(message: Buffer, _port: number, _host: string, callback: (error: null) => void) {
				const query = message.toString();
				const payload = query.includes("M-SEARCH")
					? "HTTP/1.0 200 OK\r\nContent-Type: plex/media-server\r\nName: Plex\r\nPort: 32400\r\nResource-Identifier: plex-1"
					: query.includes("Jellyfin")
						? '{"Address":"http://10.0.0.2:8096","Id":"jelly-1","Name":"Jellyfin"}'
						: '{"Address":"http://10.0.0.3:8096","Id":"emby-1","Name":"Emby"}';
				queueMicrotask(() => {
					for (const handler of handlers.get("message") ?? []) {
						(handler as (...args: unknown[]) => void)(Buffer.from(payload), {
							address: query.includes("M-SEARCH") ? "192.168.1.2" : "192.168.1.3",
							family: "IPv4",
							port: 7359,
							size: payload.length,
						});
					}
					callback(null);
				});
				return socket;
			},
			close() {
				return socket;
			},
		};
		return socket as unknown as Socket;
	};
}

describe("bounded UDP setup discovery", () => {
	it("runs every supported probe concurrently and returns parsed candidates", async () => {
		const result = await discoverMediaServers({
			timeoutMs: 5,
			socketFactory: respondingSocketFactory(),
		});
		expect(result.scannedProtocols).toEqual(SETUP_DISCOVERY_PROTOCOLS);
		expect(result.candidates.map((candidate) => candidate.service).sort()).toEqual([
			"emby",
			"jellyfin",
			"plex",
		]);
	});

	it("deduplicates repeated datagrams by service and stable server identity", () => {
		const candidate = {
			service: "plex" as const,
			name: "Plex",
			baseUrl: "http://192.168.1.2:32400",
			serverId: "plex-1",
			protocol: "plex-gdm" as const,
		};
		expect(deduplicateCandidates([candidate, { ...candidate, name: "Duplicate" }])).toEqual([
			candidate,
		]);
	});

	it("fails silent-and-fast when UDP sockets are unavailable", async () => {
		const result = await discoverMediaServers({
			socketFactory: () => {
				throw new Error("UDP disabled");
			},
		});
		expect(result.candidates).toEqual([]);
		expect(result.scannedProtocols).toEqual(SETUP_DISCOVERY_PROTOCOLS);
		expect(result.durationMs).toBeLessThan(100);
	});
});
