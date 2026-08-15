import { afterEach, describe, expect, it, vi } from "vitest";
import { TautulliClient } from "../tautulli-client.js";

const log = { warn: vi.fn() } as never;

function success(data: unknown): Response {
	return new Response(JSON.stringify({ response: { result: "success", message: null, data } }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("TautulliClient server identity", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("uses get_server_info.pms_identifier as the primary identity", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(success({ pms_identifier: "primary-id", pms_name: "Plex" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getServerIdentity(),
		).resolves.toEqual({
			identifier: "primary-id",
			displayName: "Plex",
		});
		expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get("cmd")).toBe(
			"get_server_info",
		);
	});

	it("falls back only when get_servers_info returns exactly one non-empty machine_identifier", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(success({ pms_identifier: "" }))
			.mockResolvedValueOnce(success([{ machine_identifier: "fallback-id", pms_name: "Plex" }]));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getServerIdentity(),
		).resolves.toEqual({
			identifier: "fallback-id",
			displayName: "Plex",
		});
	});

	it("uses the single compatibility fallback when get_server_info omits pms_identifier", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(success({ pms_name: "Plex" }))
			.mockResolvedValueOnce(success([{ machine_identifier: "fallback-id", pms_name: "Plex" }]));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getServerIdentity(),
		).resolves.toEqual({
			identifier: "fallback-id",
			displayName: "Plex",
		});
	});

	it.each([
		[[]],
		[[{ machine_identifier: "" }]],
		[[{ machine_identifier: "one" }, { machine_identifier: "two" }]],
		[[{ machine_identifier: "same" }, { machine_identifier: "same" }]],
		[[{ machine_identifier: 42 }]],
	])("rejects an ambiguous or malformed compatibility fallback: %j", async (servers) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(success({ pms_identifier: "" }))
				.mockResolvedValueOnce(success(servers)),
		);

		await expect(
			new TautulliClient("http://tautulli.test", "api-key", log).getServerIdentity(),
		).rejects.toThrow("Tautulli server identity is unavailable");
	});
});
