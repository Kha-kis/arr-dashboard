import type { QuiInstance, QuiTorrent } from "@arr/shared";
import { describe, expect, it, vi } from "vitest";
import { assertQuiActionTargets } from "../action-target-authority.js";
import type { QuiClient } from "../client-factory.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

function makeClient(args?: {
	instances?: Array<Pick<QuiInstance, "id" | "connected" | "isActive">>;
	matches?: Record<string, Array<Pick<QuiTorrent, "hash" | "instanceId">>>;
}) {
	return {
		listInstances: vi
			.fn()
			.mockResolvedValue(
				(args?.instances ?? [{ id: 7, connected: true, isActive: true }]) as QuiInstance[],
			),
		getTorrentsByHash: vi.fn().mockImplementation(async (hash: string) => {
			return (args?.matches?.[hash.toLowerCase()] ?? [{ hash, instanceId: 7 }]) as QuiTorrent[];
		}),
	} as Pick<QuiClient, "listInstances" | "getTorrentsByHash">;
}

describe("qUI action execution-time target authority", () => {
	it("accepts only a complete exact match on the selected connected qBit instance", async () => {
		const client = makeClient({
			matches: {
				[HASH_A]: [
					{ hash: HASH_A.toUpperCase(), instanceId: 3 },
					{ hash: HASH_A, instanceId: 7 },
				],
				[HASH_B]: [{ hash: HASH_B, instanceId: 7 }],
			},
		});
		await expect(assertQuiActionTargets(client, 7, [HASH_A, HASH_B])).resolves.toBeUndefined();
		expect(client.getTorrentsByHash).toHaveBeenCalledTimes(2);
	});

	it("fails the entire selection when any hash is absent from the selected instance", async () => {
		const client = makeClient({
			matches: {
				[HASH_A]: [{ hash: HASH_A, instanceId: 7 }],
				[HASH_B]: [{ hash: HASH_B, instanceId: 3 }],
			},
		});
		await expect(assertQuiActionTargets(client, 7, [HASH_A, HASH_B])).rejects.toThrow(
			"qUI action target could not be verified",
		);
	});

	it("rejects a disconnected target or duplicated hash before any lookup", async () => {
		const disconnected = makeClient({
			instances: [{ id: 7, connected: false, isActive: true }],
		});
		await expect(assertQuiActionTargets(disconnected, 7, [HASH_A])).rejects.toThrow(
			"qUI action target could not be verified",
		);
		expect(disconnected.getTorrentsByHash).not.toHaveBeenCalled();

		const duplicate = makeClient();
		await expect(
			assertQuiActionTargets(duplicate, 7, [HASH_A, HASH_A.toUpperCase()]),
		).rejects.toThrow("qUI action selection contains duplicate hashes");
		expect(duplicate.listInstances).not.toHaveBeenCalled();
	});
});
