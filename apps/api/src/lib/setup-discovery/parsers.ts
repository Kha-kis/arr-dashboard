import type { SetupDiscoveryCandidate } from "@arr/shared";

type RemoteInfo = { address: string };

function parseHeaders(payload: Buffer | string): {
	statusLine: string;
	headers: Map<string, string>;
} {
	const lines = payload.toString().split(/\r?\n/);
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const separator = line.indexOf(":");
		if (separator < 1) continue;
		headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
	}
	return { statusLine: lines[0] ?? "", headers };
}

function localBaseUrl(reportedAddress: string, remote: RemoteInfo): string | null {
	try {
		const parsed = new URL(
			reportedAddress.includes("://") ? reportedAddress : `http://${reportedAddress}`,
		);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		parsed.hostname = remote.address;
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return null;
	}
}

export function parsePlexGdmResponse(
	payload: Buffer | string,
	remote: RemoteInfo,
): SetupDiscoveryCandidate | null {
	const { statusLine, headers } = parseHeaders(payload);
	if (!statusLine.includes("200 OK")) return null;
	if (headers.get("content-type") !== "plex/media-server") return null;
	const port = Number(headers.get("port"));
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

	return {
		service: "plex",
		name: headers.get("name")?.slice(0, 120) || "Plex Media Server",
		baseUrl: `http://${remote.address}:${port}`,
		serverId: headers.get("resource-identifier")?.slice(0, 256) || null,
		protocol: "plex-gdm",
	};
}

const PLEX_DLNA_PORT = 32469;
const PLEX_HTTP_PORT = 32400;
const MEDIA_SERVER_ST = "urn:schemas-upnp-org:device:mediaserver:1";

export function parsePlexSsdpResponse(
	payload: Buffer | string,
	remote: RemoteInfo,
): SetupDiscoveryCandidate | null {
	const { statusLine, headers } = parseHeaders(payload);
	if (!/^HTTP\/1\.[01] 200(?:\s|$)/i.test(statusLine)) return null;
	if (headers.get("st")?.toLowerCase() !== MEDIA_SERVER_ST) return null;

	let location: URL;
	try {
		location = new URL(headers.get("location") ?? "");
	} catch {
		return null;
	}
	if (location.protocol !== "http:" || Number(location.port) !== PLEX_DLNA_PORT) return null;

	const usn = headers.get("usn") ?? "";
	const match = /^uuid:([^:]+)::urn:schemas-upnp-org:device:mediaserver:1$/i.exec(usn);
	if (!match?.[1]) return null;

	return {
		service: "plex",
		name: "Plex Media Server",
		baseUrl: `http://${remote.address}:${PLEX_HTTP_PORT}`,
		serverId: match[1].slice(0, 256),
		protocol: "plex-ssdp",
	};
}

export function parseMediaBrowserUdpResponse(
	service: "jellyfin" | "emby",
	payload: Buffer | string,
	remote: RemoteInfo,
): SetupDiscoveryCandidate | null {
	try {
		const parsed = JSON.parse(payload.toString()) as Record<string, unknown>;
		if (typeof parsed.Address !== "string" || typeof parsed.Name !== "string") return null;
		const baseUrl = localBaseUrl(parsed.Address, remote);
		if (!baseUrl || parsed.Name.trim().length === 0) return null;
		return {
			service,
			name: parsed.Name.trim().slice(0, 120),
			baseUrl,
			serverId:
				typeof parsed.Id === "string" && parsed.Id.length > 0 ? parsed.Id.slice(0, 256) : null,
			protocol: service === "jellyfin" ? "jellyfin-udp" : "emby-udp",
		};
	} catch {
		return null;
	}
}
