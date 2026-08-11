#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PIECE_LENGTH = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 60_000;

export const TORRENT_FIXTURES = Object.freeze([
	{
		service: "qbittorrent-a",
		baseUrl: "http://qbittorrent-a:8080",
		sourcePath: "/data/torrents/radarr-a/The.Matrix.1999.1080p.BluRay.x264-LCE2E.mkv",
	},
	{
		service: "qbittorrent-a",
		baseUrl: "http://qbittorrent-a:8080",
		sourcePath: "/data/torrents/sonarr-a/Breaking.Bad.S01E01.1080p.BluRay.x264-LCE2E.mkv",
	},
	{
		service: "qbittorrent-b",
		baseUrl: "http://qbittorrent-b:8080",
		sourcePath: "/data/torrents/radarr-b/The.Matrix.1999.2160p.UHD.BluRay.x265-LCE2E.mkv",
	},
	{
		service: "qbittorrent-b",
		baseUrl: "http://qbittorrent-b:8080",
		sourcePath: "/data/torrents/sonarr-b/Breaking.Bad.S01E01.2160p.UHD.BluRay.x265-LCE2E.mkv",
	},
]);

export function assertHarnessQbitUrl(value, service) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== service ||
		url.port !== "8080" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error(`${service} must use its exact uncredentialed harness-network endpoint`);
	}
	return url.origin;
}

export function bencode(value) {
	if (Buffer.isBuffer(value)) {
		return Buffer.concat([Buffer.from(`${value.length}:`), value]);
	}
	if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
	if (Number.isSafeInteger(value) && value >= 0) return Buffer.from(`i${value}e`);
	if (Array.isArray(value)) {
		return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) =>
			Buffer.compare(Buffer.from(left), Buffer.from(right)),
		);
		return Buffer.concat([
			Buffer.from("d"),
			...entries.flatMap(([key, child]) => [bencode(key), bencode(child)]),
			Buffer.from("e"),
		]);
	}
	throw new Error("unsupported bencode value");
}

export function buildTorrent(fileName, content) {
	if (!/^[A-Za-z0-9._-]+\.mkv$/.test(fileName)) throw new Error("unsafe fixture filename");
	if (!Buffer.isBuffer(content) || content.length === 0) throw new Error("empty fixture content");

	const pieceHashes = [];
	for (let offset = 0; offset < content.length; offset += PIECE_LENGTH) {
		pieceHashes.push(
			createHash("sha1")
				.update(content.subarray(offset, offset + PIECE_LENGTH))
				.digest(),
		);
	}
	const info = {
		length: content.length,
		name: fileName,
		"piece length": PIECE_LENGTH,
		pieces: Buffer.concat(pieceHashes),
	};
	return {
		infoHash: createHash("sha1").update(bencode(info)).digest("hex"),
		metainfo: bencode({
			announce: "http://tracker.invalid/announce",
			"created by": "arr-dashboard library-cleanup gauntlet",
			"creation date": 1_786_147_200,
			info,
		}),
	};
}

function credentialEnvironmentNames(service) {
	const prefix = service.toUpperCase().replaceAll("-", "_");
	return {
		password: `${prefix}_PASSWORD`,
		username: `${prefix}_USERNAME`,
	};
}

export function resolveQbitCredentials(service, environment = process.env) {
	const names = credentialEnvironmentNames(service);
	const username = environment[names.username];
	const password = environment[names.password];
	if (typeof username !== "string" || username.length === 0) {
		throw new Error(`${service} requires ${names.username}`);
	}
	if (typeof password !== "string" || password.length === 0) {
		throw new Error(`${service} requires ${names.password}`);
	}
	return { username, password };
}

function extractSidCookie(response) {
	const setCookies =
		typeof response.headers.getSetCookie === "function"
			? response.headers.getSetCookie()
			: [response.headers.get("set-cookie")].filter(Boolean);
	for (const setCookie of setCookies) {
		const match = /(?:^|;\s*)SID=([^;,\s]+)/.exec(setCookie);
		if (match?.[1]) return `SID=${match[1]}`;
	}
	return undefined;
}

export async function createQbitSession({
	baseUrl,
	credentials,
	fetchImpl = fetch,
	service,
}) {
	const endpoint = "/api/v2/auth/login";
	const response = await fetchImpl(`${baseUrl}${endpoint}`, {
		body: new URLSearchParams(credentials),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		method: "POST",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	await response.text();
	if (!response.ok) {
		throw new Error(`${service} POST ${endpoint} failed with HTTP ${response.status}`);
	}
	const sidCookie = extractSidCookie(response);
	if (!sidCookie) {
		throw new Error(`${service} POST ${endpoint} failed with HTTP ${response.status}: SID cookie missing`);
	}
	return { baseUrl, fetchImpl, service, sidCookie };
}

export async function qbitRequest(session, endpoint, init = {}) {
	const method = init.method ?? "GET";
	const response = await session.fetchImpl(`${session.baseUrl}${endpoint}`, {
		...init,
		headers: { ...init.headers, Cookie: session.sidCookie },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${session.service} ${method} ${endpoint} failed with HTTP ${response.status}`);
	}
	return text;
}

async function addAndVerify(fixture, session) {
	const baseUrl = assertHarnessQbitUrl(fixture.baseUrl, fixture.service);
	if (session.baseUrl !== baseUrl || session.service !== fixture.service) {
		throw new Error(`${fixture.service} session does not match its isolated endpoint`);
	}
	const content = await readFile(fixture.sourcePath);
	if (!content.includes(Buffer.from("ARR-DASHBOARD-LIBRARY-CLEANUP-E2E"))) {
		throw new Error(`${fixture.service} source is not a guarded gauntlet fixture`);
	}
	const fileName = path.posix.basename(fixture.sourcePath);
	const { infoHash, metainfo } = buildTorrent(fileName, content);
	const existing = JSON.parse(
		await qbitRequest(session, `/api/v2/torrents/info?hashes=${infoHash}`),
	);
	if (existing.length === 0) {
		const form = new FormData();
		form.append("torrents", new Blob([metainfo]), `${fileName}.torrent`);
		form.append("savepath", path.posix.dirname(fixture.sourcePath));
		form.append("category", "arr-dashboard-library-cleanup-gauntlet");
		await qbitRequest(session, "/api/v2/torrents/add", { method: "POST", body: form });
	}

	const deadline = Date.now() + VERIFY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const torrents = JSON.parse(
			await qbitRequest(session, `/api/v2/torrents/info?hashes=${infoHash}`),
		);
		const torrent = torrents[0];
		if (
			torrent?.hash?.toLowerCase() === infoHash &&
			torrent.name === fileName &&
			torrent.save_path === path.posix.dirname(fixture.sourcePath) &&
			Number(torrent.size) === content.length
		) {
			process.stdout.write(`${fixture.service}: ${fileName} ready (${infoHash.slice(0, 8)})\n`);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${fixture.service} did not expose the exact torrent fixture`);
}

export async function main({ environment = process.env, fetchImpl = fetch } = {}) {
	const sessions = new Map();
	for (const fixture of TORRENT_FIXTURES) {
		let session = sessions.get(fixture.service);
		if (!session) {
			const baseUrl = assertHarnessQbitUrl(fixture.baseUrl, fixture.service);
			session = await createQbitSession({
				baseUrl,
				credentials: resolveQbitCredentials(fixture.service, environment),
				fetchImpl,
				service: fixture.service,
			});
			sessions.set(fixture.service, session);
		}
		await addAndVerify(fixture, session);
	}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(
			`Torrent bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
