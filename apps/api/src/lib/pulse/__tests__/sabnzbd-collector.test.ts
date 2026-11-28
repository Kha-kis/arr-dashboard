import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { collectSabnzbdSignals } from "../sabnzbd-collector.js";

const log = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(),
	level: "info",
	silent: vi.fn(),
} as unknown as FastifyBaseLogger;

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("SABnzbd Pulse collector", () => {
	it("uses owner-scoped credentials and never exposes provider failure text", async () => {
		const findMany = vi.fn().mockResolvedValue([
			{
				id: "sab-1",
				userId: "owner-1",
				label: "NAS downloads",
				baseUrl: "http://sab.local",
				encryptedApiKey: "ciphertext",
				encryptionIv: "iv",
				enabled: true,
			},
		]);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(json({ warnings: ["secret token /private/path"] }))
			.mockResolvedValueOnce(
				json({
					history: { slots: [{ status: "Failed", fail_message: "password /private/path" }] },
				}),
			);
		const items = await collectSabnzbdSignals(
			{
				prisma: { serviceInstance: { findMany } },
				encryptor: { decrypt: vi.fn().mockReturnValue("api-key") },
			} as never,
			"owner-1",
			log,
		);

		expect(findMany).toHaveBeenCalledWith({
			where: { userId: "owner-1", service: "SABNZBD", enabled: true },
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(items).toHaveLength(2);
		expect(JSON.stringify(items)).not.toMatch(/secret token|private\/path|password|api-key/i);
		expect(items.map((item) => item.title)).toEqual([
			"NAS downloads has 1 warning",
			"1 recent SABnzbd job failed",
		]);
	});
});
