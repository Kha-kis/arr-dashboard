import { afterEach, describe, expect, it, vi } from "vitest";
import { createJellyfinClient } from "../jellyfin-client.js";

const encryptedCredentials = JSON.stringify({ v: 1, username: "proxy", password: "secret" });
const encryptor = {
	decrypt: vi.fn(({ value }: { value: string }) =>
		value === "encrypted-api-key" ? "api-key" : encryptedCredentials,
	),
};
const log = { warn: vi.fn() };

const instance = (service: "JELLYFIN" | "EMBY", withHttpAuth: boolean) => ({
	id: "media-1",
	baseUrl: "https://media.example.test",
	encryptedApiKey: "encrypted-api-key",
	encryptionIv: "api-iv",
	encryptedHttpAuthCredentials: withHttpAuth ? "encrypted-http-auth" : null,
	httpAuthEncryptionIv: withHttpAuth ? "http-iv" : null,
	service,
});

describe("JellyfinClient HTTP authentication", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("uses modern Authorization authentication when no proxy Basic Auth is configured", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(
			encryptor as never,
			instance("JELLYFIN", false),
			log as never,
		);

		await client.getUsers();

		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.Authorization).toContain("MediaBrowser");
		expect(headers["X-Emby-Token"]).toBeUndefined();
	});

	it("rejects proxy Basic Auth for Jellyfin instead of using deprecated auth headers", () => {
		expect(() =>
			createJellyfinClient(encryptor as never, instance("JELLYFIN", true), log as never),
		).toThrow(/cannot be combined with modern Jellyfin authentication/i);
	});

	it("retains the alternate Emby headers when its proxy uses Basic Auth", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(encryptor as never, instance("EMBY", true), log as never);

		await client.getUsers();

		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Basic cHJveHk6c2VjcmV0");
		expect(headers["X-Emby-Token"]).toBe("api-key");
	});
});
