import http from "node:http";
import https from "node:https";
import {
	applyRequestPolicy,
	applyResponsePolicy,
	isItemInventoryRequest,
} from "./proxy-policy.mjs";

const allowedModes = new Set([
	"normal",
	"paginate",
	"boxset-only",
	"unknown-type",
	"malformed",
	"unavailable",
]);
const listenHost = process.env.JELLYFIN_PROXY_HOST ?? "0.0.0.0";
const listenPort = Number(process.env.JELLYFIN_PROXY_PORT ?? "18096");
const upstreamBase = new URL(process.env.JELLYFIN_UPSTREAM ?? "http://jellyfin:8096");
let mode = "normal";
let itemInventoryRequests = 0;
let upstreamRequests = 0;

function sendJson(response, status, body) {
	const encoded = Buffer.from(JSON.stringify(body));
	response.writeHead(status, {
		"content-length": encoded.length,
		"content-type": "application/json",
	});
	response.end(encoded);
}

async function readJson(request) {
	let encoded = "";
	for await (const chunk of request) {
		encoded += chunk;
		if (encoded.length > 1024) throw new Error("control payload too large");
	}
	return JSON.parse(encoded);
}

async function updateMode(request, response) {
	if (request.method !== "PUT") {
		response.writeHead(405, { allow: "PUT" });
		response.end();
		return;
	}

	try {
		const body = await readJson(request);
		if (!allowedModes.has(body.mode)) {
			sendJson(response, 400, { error: "invalid_fixture_mode" });
			return;
		}
		mode = body.mode;
		itemInventoryRequests = 0;
		upstreamRequests = 0;
		response.writeHead(204);
		response.end();
	} catch {
		sendJson(response, 400, { error: "invalid_fixture_control" });
	}
}

function forward(request, response) {
	const selectedMode = mode;
	const requestPolicy = applyRequestPolicy({ mode: selectedMode, url: request.url });
	if (requestPolicy.shortCircuit) {
		sendJson(response, requestPolicy.status, requestPolicy.body);
		return;
	}
	upstreamRequests += 1;
	if (isItemInventoryRequest(request.url)) itemInventoryRequests += 1;

	const upstreamUrl = new URL(requestPolicy.url, upstreamBase);
	const transport = upstreamUrl.protocol === "https:" ? https : http;
	const forwardedHeaders = {
		...request.headers,
		"accept-encoding": "identity",
		host: upstreamUrl.host,
	};
	const upstreamRequest = transport.request(
		upstreamUrl,
		{ headers: forwardedHeaders, method: request.method },
		(upstreamResponse) => {
			const chunks = [];
			upstreamResponse.on("data", (chunk) => chunks.push(chunk));
			upstreamResponse.on("end", () => {
				const encoded = Buffer.concat(chunks);
				const responseHeaders = { ...upstreamResponse.headers };
				const contentType = String(responseHeaders["content-type"] ?? "");
				if (!contentType.includes("application/json") || encoded.length === 0) {
					response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
					response.end(encoded);
					return;
				}

				try {
					const transformed = applyResponsePolicy({
						body: JSON.parse(encoded.toString("utf8")),
						mode: selectedMode,
						url: request.url,
					});
					const transformedBody = Buffer.from(JSON.stringify(transformed.body));
					responseHeaders["content-length"] = String(transformedBody.length);
					delete responseHeaders["content-encoding"];
					delete responseHeaders["transfer-encoding"];
					response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
					response.end(transformedBody);
				} catch {
					sendJson(response, 502, { error: "fixture_upstream_json_invalid" });
				}
			});
		},
	);
	upstreamRequest.on("error", () => {
		if (!response.headersSent) sendJson(response, 502, { error: "fixture_upstream_unavailable" });
		else response.end();
	});
	request.pipe(upstreamRequest);
}

const server = http.createServer((request, response) => {
	const path = new URL(request.url, "http://fixture.invalid").pathname;
	if (path === "/__fixture/health") {
		response.writeHead(204);
		response.end();
		return;
	}
	if (path === "/__fixture/status") {
		sendJson(response, 200, { itemInventoryRequests, mode, upstreamRequests });
		return;
	}
	if (path === "/__fixture/mode") {
		void updateMode(request, response);
		return;
	}
	forward(request, response);
});

server.listen(listenPort, listenHost, () => {
	const address = server.address();
	const boundPort = typeof address === "object" && address ? address.port : listenPort;
	process.stdout.write(`fixture-proxy-ready:${boundPort}\n`);
});

process.on("SIGTERM", () => server.close());
