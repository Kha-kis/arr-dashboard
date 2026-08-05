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

async function qbitRequest(baseUrl, endpoint, init = {}) {
	const response = await fetch(`${baseUrl}${endpoint}`, {
		...init,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${init.method ?? "GET"} ${endpoint} failed with HTTP ${response.status}`);
	}
	return text;
}

async function addAndVerify(fixture) {
	const baseUrl = assertHarnessQbitUrl(fixture.baseUrl, fixture.service);
	const content = await readFile(fixture.sourcePath);
	if (!content.includes(Buffer.from("ARR-DASHBOARD-LIBRARY-CLEANUP-E2E"))) {
		throw new Error(`${fixture.service} source is not a guarded gauntlet fixture`);
	}
	const fileName = path.posix.basename(fixture.sourcePath);
	const { infoHash, metainfo } = buildTorrent(fileName, content);
	const existing = JSON.parse(
		await qbitRequest(baseUrl, `/api/v2/torrents/info?hashes=${infoHash}`),
	);
	if (existing.length === 0) {
		const form = new FormData();
		form.append("torrents", new Blob([metainfo]), `${fileName}.torrent`);
		form.append("savepath", path.posix.dirname(fixture.sourcePath));
		form.append("category", "arr-dashboard-library-cleanup-gauntlet");
		await qbitRequest(baseUrl, "/api/v2/torrents/add", { method: "POST", body: form });
	}

	const deadline = Date.now() + VERIFY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const torrents = JSON.parse(
			await qbitRequest(baseUrl, `/api/v2/torrents/info?hashes=${infoHash}`),
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

export async function main() {
	for (const fixture of TORRENT_FIXTURES) await addAndVerify(fixture);
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
