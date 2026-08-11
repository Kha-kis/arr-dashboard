#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "http://plex:33240";
const REQUEST_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 180_000;

export const PLEX_LIBRARIES = Object.freeze([
	{
		name: "Library Cleanup Movies",
		type: "movie",
		agent: "tv.plex.agents.movie",
		scanner: "Plex Movie",
		locations: ["/plex/data/library/radarr-a", "/plex/data/library/radarr-b"],
		expectedTitle: "The Matrix",
	},
	{
		name: "Library Cleanup TV",
		type: "show",
		agent: "tv.plex.agents.series",
		scanner: "Plex TV Series",
		locations: ["/plex/data/library/sonarr-a", "/plex/data/library/sonarr-b"],
		expectedTitle: "Breaking Bad",
	},
]);

export function assertHarnessPlexUrl(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "plex" ||
		url.port !== "33240" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("Plex must use the exact isolated loopback-bridge endpoint");
	}
	return url.origin;
}

export function buildLibraryQuery(library) {
	const query = new URLSearchParams({
		name: library.name,
		type: library.type,
		agent: library.agent,
		scanner: library.scanner,
		language: "en-US",
	});
	for (const location of library.locations) query.append("location", location);
	return query;
}

function decodeXml(value) {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

export function parseSections(xml) {
	const sections = [];
	for (const match of xml.matchAll(/<Directory\s+([^>]+)>[\s\S]*?<\/Directory>/g)) {
		const attributes = Object.fromEntries(
			[...match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)].map((entry) => [
				entry[1],
				decodeXml(entry[2]),
			]),
		);
		const locations = [...match[0].matchAll(/<Location[^>]+path="([^"]+)"/g)].map((entry) =>
			decodeXml(entry[1]),
		);
		sections.push({
			key: attributes.key,
			title: attributes.title,
			type: attributes.type,
			locations,
		});
	}
	return sections;
}

async function request(endpoint, init = {}) {
	const response = await fetch(`${assertHarnessPlexUrl(BASE_URL)}${endpoint}`, {
		...init,
		headers: { accept: "application/json", ...init.headers },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`${init.method ?? "GET"} ${endpoint} failed with HTTP ${response.status}`);
	}
	return { text, json: () => JSON.parse(text) };
}

async function listSections() {
	const response = await request("/library/sections", { headers: { accept: "application/xml" } });
	return parseSections(response.text);
}

async function ensureLibrary(library) {
	let sections = await listSections();
	const matching = sections.filter((section) => section.title === library.name);
	if (matching.length > 1) throw new Error(`Duplicate Plex section ${library.name}`);
	if (matching.length === 0) {
		await request(`/library/sections?${buildLibraryQuery(library)}`, { method: "POST" });
		sections = await listSections();
	}
	const section = sections.find((candidate) => candidate.title === library.name);
	if (!section?.key || section.type !== library.type) {
		throw new Error(`Plex did not create the exact ${library.name} section`);
	}
	if (
		section.locations.length !== library.locations.length ||
		library.locations.some((location) => !section.locations.includes(location))
	) {
		throw new Error(`${library.name} does not use the exact disposable fixture roots`);
	}
	await request(`/library/sections/${section.key}/refresh`, { method: "POST" });
	return section;
}

async function waitForTitle(section, expectedTitle) {
	const deadline = Date.now() + SCAN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const payload = (await request(`/library/sections/${section.key}/all`)).json();
		const items = payload?.MediaContainer?.Metadata;
		if (Array.isArray(items) && items.some((item) => item.title === expectedTitle)) return;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	throw new Error(`${section.title} did not index ${expectedTitle} within the scan budget`);
}

async function ensureWatchedEpisode(showSection) {
	const shows = (await request(`/library/sections/${showSection.key}/all`)).json()?.MediaContainer
		?.Metadata;
	const show = Array.isArray(shows)
		? shows.find((candidate) => candidate.title === "Breaking Bad")
		: undefined;
	if (show?.ratingKey !== "15") {
		throw new Error("Plex Breaking Bad fixture did not retain rating key 15");
	}

	const episodes = (await request(`/library/metadata/${show.ratingKey}/allLeaves`)).json()
		?.MediaContainer?.Metadata;
	const episode = Array.isArray(episodes)
		? episodes.find(
				(candidate) =>
					candidate.title === "Pilot" && candidate.parentIndex === 1 && candidate.index === 1,
			)
		: undefined;
	if (episode?.ratingKey !== "17") {
		throw new Error("Plex Pilot fixture did not retain rating key 17");
	}
	await request(
		`/:/scrobble?key=${encodeURIComponent(episode.ratingKey)}&identifier=com.plexapp.plugins.library`,
	);
	const refreshedEpisodes = (await request(`/library/metadata/${show.ratingKey}/allLeaves`)).json()
		?.MediaContainer?.Metadata;
	const refreshed = Array.isArray(refreshedEpisodes)
		? refreshedEpisodes.find((candidate) => candidate.ratingKey === episode.ratingKey)
		: undefined;
	if (!Number.isSafeInteger(refreshed?.viewCount) || refreshed.viewCount < 1) {
		throw new Error("Plex Pilot fixture did not record a watched state");
	}
}

export async function main() {
	let showSection;
	for (const library of PLEX_LIBRARIES) {
		const section = await ensureLibrary(library);
		await waitForTitle(section, library.expectedTitle);
		if (library.type === "show") showSection = section;
		process.stdout.write(`${library.name}: ${library.expectedTitle} indexed\n`);
	}
	if (!showSection) throw new Error("Plex show fixture section was not available");
	await ensureWatchedEpisode(showSection);
	process.stdout.write("Library Cleanup TV: Breaking Bad S01E01 watched state ready\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(
			`Plex bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
