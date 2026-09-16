import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LISTEN_PORT = 33240;
const PLEX_PORT = 32400;
const RUN_TOKEN_FILE = "/run/secrets/run_token";

export const PLEX_FIXTURE_MODES = Object.freeze([
	"normal",
	"paginated-history",
	"paginated-catalog",
	"catalog-failure",
	"identity-override",
	"controlled",
]);

const HISTORY_ROWS = Object.freeze([
	{
		ratingKey: "17",
		historyKey: "lc-e2e-plex-history-pilot-17-a",
		parentRatingKey: "16",
		grandparentRatingKey: "15",
		title: "Pilot",
		grandparentTitle: "Breaking Bad",
		type: "episode",
		viewedAt: 1785876613,
		accountID: 1,
	},
	{
		ratingKey: "17",
		historyKey: "lc-e2e-plex-history-pilot-17-b",
		parentRatingKey: "16",
		grandparentRatingKey: "15",
		title: "Pilot",
		grandparentTitle: "Breaking Bad",
		type: "episode",
		viewedAt: 1785876612,
		accountID: 1,
	},
]);

const CATALOG_ROWS = Object.freeze({
	1: Object.freeze([
		{
			ratingKey: "lc-e2e-catalog-movie-a",
			title: "LC Catalog Movie A",
			type: "movie",
			year: 2026,
			addedAt: 1785876613,
			Guid: [{ id: "tmdb://603" }],
		},
		{
			ratingKey: "lc-e2e-catalog-movie-b",
			title: "LC Catalog Movie B",
			type: "movie",
			year: 2026,
			addedAt: 1785876612,
			Guid: [{ id: "tmdb://604" }],
		},
	]),
	2: Object.freeze([
		{
			ratingKey: "lc-e2e-catalog-show-a",
			title: "LC Catalog Show A",
			type: "show",
			year: 2026,
			addedAt: 1785876613,
			Guid: [{ id: "tmdb://81189" }, { id: "tvdb://81189" }],
		},
		{
			ratingKey: "lc-e2e-catalog-show-b",
			title: "LC Catalog Show B",
			type: "show",
			year: 2026,
			addedAt: 1785876612,
			Guid: [{ id: "tmdb://81190" }, { id: "tvdb://81190" }],
		},
	]),
});

function historyRowsFor(mode, offset) {
	if (mode === "paginated-history") return HISTORY_ROWS.slice(offset, offset + 1);
	return offset === 0 ? [HISTORY_ROWS[0]] : [];
}

export function isCatalogEndpoint(pathname) {
	return /^\/library\/sections\/[^/]+\/all$/.test(pathname);
}

export function historyPayload(mode, offset) {
	const rows = historyRowsFor(mode, offset);
	const totalSize = mode === "paginated-history" ? HISTORY_ROWS.length : 1;
	return {
		MediaContainer: {
			size: rows.length,
			totalSize,
			offset,
			Metadata: rows,
		},
	};
}

export function catalogPayload(mode, sectionId, offset) {
	const rows = mode === "paginated-catalog" ? (CATALOG_ROWS[sectionId] ?? []) : [];
	const page = rows.slice(offset, offset + 1);
	return {
		MediaContainer: {
			size: page.length,
			totalSize: rows.length,
			offset,
			Metadata: page,
		},
	};
}

function syntheticMetadataPayload(pathname) {
	const match = /^\/library\/metadata\/([^/]+)$/.exec(pathname);
	if (!match) return null;
	const keys = decodeURIComponent(match[1]).split(",");
	if (keys.length === 0 || keys.some((key) => !key.startsWith("lc-e2e-catalog-"))) return null;
	return {
		MediaContainer: {
			size: keys.length,
			Metadata: keys.map((ratingKey) => ({ ratingKey })),
		},
	};
}

export function rewriteIdentityPayload(payload) {
	const copy = structuredClone(payload);
	if (copy?.MediaContainer && typeof copy.MediaContainer === "object") {
		copy.MediaContainer.machineIdentifier = "lc-e2e-identity-override";
	}
	return copy;
}

export function parseControlBody(value, expectedToken) {
	if (typeof value !== "string" || value.length > 4096) return null;
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		parsed.token !== expectedToken ||
		!PLEX_FIXTURE_MODES.includes(parsed.mode)
	) {
		return null;
	}
	return { mode: parsed.mode };
}

function readRunToken() {
	return fs.readFileSync(RUN_TOKEN_FILE, "utf8").trim();
}

function sendJson(response, statusCode, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size <= 4096) chunks.push(chunk);
		});
		request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function forward(request, response, requestUrl, rewriteIdentity, plexPort) {
	const { "x-plex-token": _discardedToken, ...forwardedHeaders } = request.headers;
	requestUrl.searchParams.delete("X-Plex-Token");
	const upstream = http.request(
		{
			host: "127.0.0.1",
			port: plexPort,
			method: request.method,
			path: requestUrl.pathname + requestUrl.search,
			headers: {
				...forwardedHeaders,
				host: `127.0.0.1:${plexPort}`,
				...(rewriteIdentity ? { "accept-encoding": "identity" } : {}),
			},
		},
		(upstreamResponse) => {
			if (!rewriteIdentity) {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
				return;
			}
			const chunks = [];
			upstreamResponse.on("data", (chunk) => chunks.push(chunk));
			upstreamResponse.on("end", () => {
				let body = Buffer.concat(chunks).toString("utf8");
				try {
					body = JSON.stringify(rewriteIdentityPayload(JSON.parse(body)));
				} catch {
					body = body.replace(
						/machineIdentifier="[^"]*"/,
						'machineIdentifier="lc-e2e-identity-override"',
					);
				}
				const headers = { ...upstreamResponse.headers };
				delete headers["content-length"];
				delete headers["content-encoding"];
				response.writeHead(upstreamResponse.statusCode ?? 502, headers);
				response.end(body);
			});
		},
	);
	upstream.on("error", () => {
		if (!response.headersSent) response.writeHead(502);
		response.end();
	});
	request.pipe(upstream);
}

export function createProxyServer({ expectedToken, initialMode = "normal", plexPort = PLEX_PORT }) {
	if (!PLEX_FIXTURE_MODES.includes(initialMode)) throw new Error("invalid fixture mode");
	let mode = initialMode;
	const server = http.createServer(async (request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://plex.invalid");
		if (requestUrl.pathname === "/__fixture/control") {
			if (request.method !== "POST") return sendJson(response, 405, { ok: false });
			const control = parseControlBody(await readRequestBody(request), expectedToken);
			if (!control) return sendJson(response, 403, { ok: false });
			mode = control.mode;
			return sendJson(response, 200, { ok: true });
		}
		if (requestUrl.pathname === "/status/sessions/history/all") {
			const offset = Number(requestUrl.searchParams.get("X-Plex-Container-Start") ?? "0");
			return sendJson(
				response,
				200,
				historyPayload(mode, Number.isSafeInteger(offset) ? offset : 0),
			);
		}
		if (mode === "paginated-catalog" && isCatalogEndpoint(requestUrl.pathname)) {
			const sectionId = /^\/library\/sections\/([^/]+)\/all$/.exec(requestUrl.pathname)?.[1] ?? "";
			const offset = Number(requestUrl.searchParams.get("X-Plex-Container-Start") ?? "0");
			return sendJson(
				response,
				200,
				catalogPayload(mode, sectionId, Number.isSafeInteger(offset) ? offset : 0),
			);
		}
		if (mode === "paginated-catalog") {
			const metadata = syntheticMetadataPayload(requestUrl.pathname);
			if (metadata) return sendJson(response, 200, metadata);
		}
		if (mode === "catalog-failure" && isCatalogEndpoint(requestUrl.pathname)) {
			return sendJson(response, 503, { error: "provider-unavailable" });
		}
		forward(
			request,
			response,
			requestUrl,
			mode === "identity-override" && requestUrl.pathname === "/identity",
			plexPort,
		);
	});
	server.fixtureMode = () => mode;
	return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const server = createProxyServer({ expectedToken: readRunToken(), initialMode: "normal" });
	server.listen(LISTEN_PORT, "0.0.0.0");
}
