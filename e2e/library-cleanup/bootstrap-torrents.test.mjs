import assert from "node:assert/strict";
import test from "node:test";

import {
	assertHarnessQbitUrl,
	bencode,
	buildTorrent,
	TORRENT_FIXTURES,
} from "./bootstrap-torrents.mjs";

test("qBittorrent URLs stay on exact isolated service endpoints", () => {
	assert.equal(
		assertHarnessQbitUrl("http://qbittorrent-a:8080", "qbittorrent-a"),
		"http://qbittorrent-a:8080",
	);
	for (const rejected of [
		"http://localhost:8080",
		"http://192.168.1.10:8080",
		"https://qbittorrent-a:8080",
		"http://user:password@qbittorrent-a:8080",
	]) {
		assert.throws(() => assertHarnessQbitUrl(rejected, "qbittorrent-a"));
	}
});

test("bencode sorts dictionary keys and preserves raw bytes", () => {
	assert.equal(
		bencode({ z: 2, a: Buffer.from([0, 255]) }).toString("hex"),
		"64313a61323a00ff313a7a69326565",
	);
});

test("torrent metainfo and infohash are deterministic", () => {
	const first = buildTorrent("fixture.mkv", Buffer.from("known fixture content"));
	const second = buildTorrent("fixture.mkv", Buffer.from("known fixture content"));
	assert.equal(first.infoHash, second.infoHash);
	assert.deepEqual(first.metainfo, second.metainfo);
	assert.match(first.infoHash, /^[a-f0-9]{40}$/);
	assert.match(first.metainfo.toString("utf8"), /tracker\.invalid/);
});

test("fixture set maps two exact payloads to each isolated qBittorrent", () => {
	assert.equal(TORRENT_FIXTURES.length, 4);
	assert.equal(TORRENT_FIXTURES.filter((item) => item.service === "qbittorrent-a").length, 2);
	assert.equal(TORRENT_FIXTURES.filter((item) => item.service === "qbittorrent-b").length, 2);
	for (const fixture of TORRENT_FIXTURES) {
		assert.match(fixture.sourcePath, /^\/data\/torrents\/(?:radarr|sonarr)-[ab]\//);
	}
});
