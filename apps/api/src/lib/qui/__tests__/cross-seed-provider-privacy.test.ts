import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QuiApiError, QuiInstanceUnreachableError } from "../../errors.js";
import type { ServiceInstance } from "../../prisma.js";
import { createQuiClient } from "../client-factory.js";
import { quiRequest } from "../client-helpers.js";

const instanceId = "PRIVATE_INSTANCE_SENTINEL";
const hash = "PRIVATE_HASH_SENTINEL";
const providerText = "PRIVATE_PROVIDER_SENTINEL";
const apiKey = "PRIVATE_APIKEY_SENTINEL";
const baseUrl = "https://private-host-sentinel.invalid/private-path-sentinel";
const authorization = `Basic ${Buffer.from("private-user:private-password").toString("base64")}`;
const sensitive = [instanceId, hash, providerText, apiKey, baseUrl, authorization];

const wireMatch = {
	hash: "sibling-hash",
	name: "Synthetic sibling",
	instance_id: 2,
	instance_name: "Synthetic qbit",
	state: "uploading",
	progress: 1,
	size: 1024,
	category: "",
	save_path: "/synthetic",
	content_path: "/synthetic/sibling",
	tracker: "https://tracker.example/announce/private-passkey",
	match_type: "release",
	tags: "",
};

function fixture() {
	const logs: string[] = [];
	const log = pino({ base: null, timestamp: false }, { write: (line) => logs.push(line) });
	const instance = {
		id: instanceId,
		baseUrl,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "synthetic-iv",
		encryptedHttpAuthCredentials: "encrypted-basic",
		httpAuthEncryptionIv: "synthetic-basic-iv",
	} as ServiceInstance;
	const app = {
		log,
		encryptor: {
			decrypt: ({ value }: { value: string }) =>
				value === "encrypted-key"
					? apiKey
					: JSON.stringify({ v: 1, username: "private-user", password: "private-password" }),
		},
	} as unknown as FastifyInstance;
	return { client: createQuiClient(app, instance), logs, log };
}

async function rejected(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return error as Error;
	}
	throw new Error("Expected provider failure");
}

function assertPrivate(logs: string[], log: ReturnType<typeof fixture>["log"], error: Error) {
	// Exercise downstream Pino's real error serializer as well as own error fields.
	log.error({ err: error }, "Synthetic downstream failure");
	const serialized = logs.join("") + JSON.stringify(error, Object.getOwnPropertyNames(error));
	for (const sentinel of sensitive) expect(serialized).not.toContain(sentinel);
	expect(error.cause).toBeUndefined();
	const warning = JSON.parse(logs[0]!);
	expect(warning.level).toBe(40);
	expect(Object.keys(warning).sort()).toEqual(["category", "level", "msg", "status"]);
	return warning;
}

describe("Cross-seed provider diagnostic privacy", () => {
	const transport = vi.fn<typeof fetch>();
	beforeEach(() => {
		transport.mockReset();
		transport.mockRejectedValue(new Error("Unconfigured synthetic transport"));
		vi.stubGlobal("fetch", transport);
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		{ status: 401, statusCode: 401, body: JSON.stringify({ message: providerText }) },
		{ status: 403, statusCode: 403, body: JSON.stringify({ error: providerText }) },
		{ status: 404, statusCode: 404, body: providerText },
		{ status: 429, statusCode: 429, body: providerText },
		{ status: 500, statusCode: 502, body: `<!doctype html><title>${providerText}</title>` },
	])("keeps HTTP $status diagnostics private and preserves status mapping", async (testCase) => {
		transport.mockResolvedValueOnce(new Response(testCase.body, { status: testCase.status }));
		const { client, logs, log } = fixture();
		const error = await rejected(client.getCrossSeedMatches(17, hash));
		expect(error).toBeInstanceOf(QuiApiError);
		expect(error).toMatchObject({
			upstreamStatus: testCase.status,
			statusCode: testCase.statusCode,
		});
		expect(assertPrivate(logs, log, error)).toMatchObject({
			category: "http",
			status: testCase.status,
		});
		expect(transport).toHaveBeenCalledOnce();
	});

	it("keeps malformed JSON and its parser cause private", async () => {
		transport.mockResolvedValueOnce(new Response(`{"${providerText}":`, { status: 200 }));
		const { client, logs, log } = fixture();
		const error = await rejected(client.getCrossSeedMatches(17, hash));
		expect(error).toBeInstanceOf(QuiApiError);
		expect(error).toMatchObject({ upstreamStatus: 200, statusCode: 502 });
		expect(assertPrivate(logs, log, error)).toMatchObject({ category: "non_json", status: 200 });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("keeps rejected schema values and validation issues private", async () => {
		transport.mockResolvedValueOnce(
			Response.json({ matches: [{ ...wireMatch, match_type: providerText }] }),
		);
		const { client, logs, log } = fixture();
		const error = await rejected(client.getCrossSeedMatches(17, hash));
		expect(error).toBeInstanceOf(QuiApiError);
		expect(error).toMatchObject({ upstreamStatus: 200, statusCode: 502 });
		expect(assertPrivate(logs, log, error)).toMatchObject({ category: "schema", status: 200 });
		expect(transport).toHaveBeenCalledOnce();
	});

	it.each(["Error", "TimeoutError"])(
		"keeps %s network diagnostics and causes private",
		async (name) => {
			const failure = new Error(`${providerText} ${apiKey} ${baseUrl}`, {
				cause: new Error(providerText),
			});
			failure.name = name;
			transport.mockRejectedValueOnce(failure);
			const { client, logs, log } = fixture();
			const error = await rejected(client.getCrossSeedMatches(17, hash));
			expect(error).toBeInstanceOf(QuiInstanceUnreachableError);
			expect(error).toMatchObject({ statusCode: 503 });
			expect(assertPrivate(logs, log, error)).toMatchObject({ category: "network", status: 503 });
			expect(transport).toHaveBeenCalledOnce();
		},
	);

	it("cancels a streaming HTTP error body without reading private content", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(providerText));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 500 },
		);
		transport.mockResolvedValueOnce(response);
		const { client, logs, log } = fixture();
		const error = await rejected(client.getCrossSeedMatches(17, hash));
		expect(cancelled).toBe(true);
		expect(error).toMatchObject({ upstreamStatus: 500, statusCode: 502 });
		expect(assertPrivate(logs, log, error)).toMatchObject({ category: "http", status: 500 });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("preserves the mapped HTTP error when body cancellation fails privately", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
					return Promise.reject(new Error(`${providerText} ${apiKey} ${baseUrl}`));
				},
			}),
			{ status: 403 },
		);
		transport.mockResolvedValueOnce(response);
		const { client, logs, log } = fixture();
		const error = await rejected(client.getCrossSeedMatches(17, hash));
		expect(cancelled).toBe(true);
		expect(error).toBeInstanceOf(QuiApiError);
		expect(error).toMatchObject({ upstreamStatus: 403, statusCode: 403 });
		expect(assertPrivate(logs, log, error)).toMatchObject({ category: "http", status: 403 });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("preserves the mapped HTTP error for a bodyless response", async () => {
		transport.mockResolvedValueOnce(new Response(null, { status: 429 }));
		const { client, logs, log } = fixture();
		const error = await rejected(client.getCrossSeedMatches(17, hash));
		expect(error).toBeInstanceOf(QuiApiError);
		expect(error).toMatchObject({ upstreamStatus: 429, statusCode: 429 });
		expect(assertPrivate(logs, log, error)).toMatchObject({ category: "http", status: 429 });
		expect(transport).toHaveBeenCalledOnce();
	});

	it("does not wait for a pending error-body cancellation acknowledgement", async () => {
		let cancelled = false;
		let release!: () => void;
		const acknowledgement = new Promise<void>((resolve) => {
			release = resolve;
		});
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
					return acknowledgement;
				},
			}),
			{ status: 503 },
		);
		transport.mockResolvedValueOnce(response);
		try {
			const { client, logs, log } = fixture();
			const error = await rejected(client.getCrossSeedMatches(17, hash));
			expect(cancelled).toBe(true);
			expect(error).toMatchObject({ upstreamStatus: 503, statusCode: 502 });
			expect(assertPrivate(logs, log, error)).toMatchObject({ category: "http", status: 503 });
		} finally {
			release();
		}
	});

	it("preserves GET, credentials, timeout signal and nonempty match normalization", async () => {
		transport.mockResolvedValueOnce(Response.json({ matches: [wireMatch] }));
		const { client, logs } = fixture();
		expect(await client.getCrossSeedMatches(17, hash)).toEqual([
			{
				hash: "sibling-hash",
				name: "Synthetic sibling",
				instanceId: 2,
				instanceName: "Synthetic qbit",
				state: "uploading",
				progress: 1,
				size: 1024,
				category: "",
				savePath: "/synthetic",
				contentPath: "/synthetic/sibling",
				tracker: "tracker.example",
				matchType: "release",
				tags: "",
			},
		]);
		expect(transport).toHaveBeenCalledOnce();
		const [url, init] = transport.mock.calls[0]!;
		expect(url).toBe(`${baseUrl}/api/cross-seed/torrents/17/${hash}/local-matches`);
		expect(init).toMatchObject({
			method: "GET",
			body: undefined,
			headers: { "X-API-Key": apiKey, Accept: "application/json", Authorization: authorization },
		});
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(init?.signal?.aborted).toBe(false);
		expect(logs).toEqual([]);
	});

	it.each([[], null])("preserves valid empty matches %s without retrying", async (matches) => {
		transport.mockResolvedValueOnce(Response.json({ matches }));
		const { client, logs } = fixture();
		expect(await client.getCrossSeedMatches(17, hash)).toEqual([]);
		expect(transport).toHaveBeenCalledOnce();
		expect(logs).toEqual([]);
	});

	it("preserves HTTP diagnostics for a caller that has not opted in", async () => {
		transport.mockResolvedValueOnce(new Response(providerText, { status: 403 }));
		const { client, logs } = fixture();
		const error = await rejected(client.listInstances());
		expect(error).toBeInstanceOf(QuiApiError);
		expect(error.message).toContain(providerText);
		expect(JSON.parse(logs[0]!)).toMatchObject({
			instanceId,
			path: "/api/instances",
			status: 403,
			message: providerText,
		});
	});

	it("preserves network identity and cause for a caller that has not opted in", async () => {
		const cause = new Error(providerText);
		transport.mockRejectedValueOnce(cause);
		const { client } = fixture();
		const error = await rejected(client.listInstances());
		expect(error).toBeInstanceOf(QuiInstanceUnreachableError);
		expect(error).toMatchObject({ instanceId, cause, message: providerText, statusCode: 503 });
	});

	it.each(["non-JSON", "schema drift"])(
		"preserves %s causes for an unopted caller",
		async (kind) => {
			transport.mockResolvedValueOnce(
				kind === "non-JSON" ? new Response(providerText) : Response.json({ private: providerText }),
			);
			const { client } = fixture();
			const error = await rejected(client.listInstances());
			expect(error).toBeInstanceOf(QuiApiError);
			expect(error).toMatchObject({ upstreamStatus: 200, statusCode: 502 });
			expect(error.message).toContain("/api/instances");
			expect(error.cause).toBeInstanceOf(Error);
		},
	);

	it.each(["before dispatch", "after response"])("preserves cancellation %s", async (phase) => {
		const controller = new AbortController();
		const reason = new DOMException("Synthetic cancellation", "AbortError");
		if (phase === "before dispatch") controller.abort(reason);
		transport.mockImplementationOnce(async () => {
			controller.abort(reason);
			return Response.json({ matches: [] });
		});
		const { log } = fixture();
		await expect(
			quiRequest({ instanceId, baseUrl, apiKey, log }, "/synthetic-read", z.unknown(), {
				signal: controller.signal,
				diagnosticPolicy: "cross-seed",
			}),
		).rejects.toBe(reason);
		expect(transport).toHaveBeenCalledTimes(phase === "before dispatch" ? 0 : 1);
	});

	it("does not publish a cancelled response from an abort-ignoring body reader", async () => {
		const controller = new AbortController();
		const reason = new DOMException("Synthetic cancellation", "AbortError");
		const response = Response.json({ matches: [] });
		vi.spyOn(response, "json").mockImplementationOnce(async () => {
			controller.abort(reason);
			return { matches: [] };
		});
		transport.mockResolvedValueOnce(response);
		const { log } = fixture();
		await expect(
			quiRequest({ instanceId, baseUrl, apiKey, log }, "/synthetic-read", z.unknown(), {
				signal: controller.signal,
				diagnosticPolicy: "cross-seed",
			}),
		).rejects.toBe(reason);
		expect(transport).toHaveBeenCalledOnce();
	});
});
