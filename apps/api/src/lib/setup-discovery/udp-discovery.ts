import type {
	SetupDiscoveryCandidate,
	SetupDiscoveryProtocol,
	SetupDiscoveryResponse,
} from "@arr/shared";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { parseMediaBrowserUdpResponse, parsePlexGdmResponse } from "./parsers.js";

const DEFAULT_TIMEOUT_MS = 1_200;
export const SETUP_DISCOVERY_PROTOCOLS = [
	"plex-gdm",
	"jellyfin-udp",
	"emby-udp",
] as const satisfies readonly SetupDiscoveryProtocol[];

interface Probe {
	protocol: SetupDiscoveryProtocol;
	message: string;
	host: string;
	port: number;
	broadcast: boolean;
	parse(payload: Buffer, remote: RemoteInfo): SetupDiscoveryCandidate | null;
}

const PROBES: readonly Probe[] = [
	{
		protocol: "plex-gdm",
		message: "M-SEARCH * HTTP/1.0",
		host: "239.0.0.250",
		port: 32414,
		broadcast: false,
		parse: parsePlexGdmResponse,
	},
	{
		protocol: "jellyfin-udp",
		message: "who is JellyfinServer?",
		host: "255.255.255.255",
		port: 7359,
		broadcast: true,
		parse: (payload, remote) => parseMediaBrowserUdpResponse("jellyfin", payload, remote),
	},
	{
		protocol: "emby-udp",
		message: "who is EmbyServer?",
		host: "255.255.255.255",
		port: 7359,
		broadcast: true,
		parse: (payload, remote) => parseMediaBrowserUdpResponse("emby", payload, remote),
	},
];

export interface DiscoveryLogger {
	debug(bindings: Record<string, unknown>, message: string): void;
}

type SocketFactory = () => Socket;

export async function discoverMediaServers(options?: {
	timeoutMs?: number;
	log?: DiscoveryLogger;
	socketFactory?: SocketFactory;
}): Promise<SetupDiscoveryResponse> {
	const startedAt = Date.now();
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const socketFactory = options?.socketFactory ?? (() => createSocket("udp4"));
	const results = await Promise.all(
		PROBES.map((probe) => runProbe(probe, timeoutMs, socketFactory, options?.log)),
	);
	const candidates = deduplicateCandidates(results.flat());
	return {
		candidates,
		scannedProtocols: [...SETUP_DISCOVERY_PROTOCOLS],
		durationMs: Date.now() - startedAt,
	};
}

function runProbe(
	probe: Probe,
	timeoutMs: number,
	socketFactory: SocketFactory,
	log?: DiscoveryLogger,
): Promise<SetupDiscoveryCandidate[]> {
	return new Promise((resolve) => {
		const candidates: SetupDiscoveryCandidate[] = [];
		let socket: Socket;
		try {
			socket = socketFactory();
		} catch (error) {
			log?.debug({ err: error, protocol: probe.protocol }, "Setup discovery socket unavailable");
			resolve([]);
			return;
		}
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				// A socket that failed before binding may already be closed.
			}
			resolve(candidates);
		};
		const timer = setTimeout(finish, timeoutMs);

		socket.on("message", (payload, remote) => {
			if (finished) return;
			const candidate = probe.parse(payload, remote);
			if (candidate) candidates.push(candidate);
		});
		socket.on("error", (error) => {
			log?.debug({ err: error, protocol: probe.protocol }, "Setup discovery probe unavailable");
			finish();
		});
		try {
			socket.bind(0, "0.0.0.0", () => {
				try {
					if (probe.broadcast) socket.setBroadcast(true);
					else socket.setMulticastTTL(1);
					socket.send(Buffer.from(probe.message), probe.port, probe.host, (error) => {
						if (error) {
							log?.debug(
								{ err: error, protocol: probe.protocol },
								"Setup discovery probe send failed",
							);
							finish();
						}
					});
				} catch (error) {
					log?.debug({ err: error, protocol: probe.protocol }, "Setup discovery probe failed");
					finish();
				}
			});
		} catch (error) {
			log?.debug({ err: error, protocol: probe.protocol }, "Setup discovery bind failed");
			finish();
		}
	});
}

export function deduplicateCandidates(
	candidates: SetupDiscoveryCandidate[],
): SetupDiscoveryCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.service}:${candidate.serverId ?? candidate.baseUrl}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
