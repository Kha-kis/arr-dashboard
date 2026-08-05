import { afterEach, describe, expect, it, vi } from "vitest";
import { recordProviderCacheRefreshFailure } from "./provider-cache-status.js";

const log = { warn: vi.fn() };

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

function fixture(current: {
	service: "PLEX" | "TAUTULLI" | "JELLYFIN";
	enabled: boolean;
	connectionGeneration: number;
}) {
	const order: string[] = [];
	const tx = {
		$queryRawUnsafe: vi.fn(async () => {
			order.push("lock");
			return [];
		}),
		serviceInstance: {
			findUnique: vi.fn(async () => {
				order.push("identity");
				return current;
			}),
		},
		cacheRefreshStatus: {
			upsert: vi.fn(async () => {
				order.push("failure");
				return {};
			}),
		},
	};
	const prisma = {
		$transaction: vi.fn(
			async (callback: (transaction: typeof tx) => Promise<unknown>, _options?: unknown) =>
				callback(tx),
		),
	};
	return { prisma, tx, order };
}

describe("recordProviderCacheRefreshFailure", () => {
	it("discards a failure from an outgoing provider generation", async () => {
		const state = fixture({ service: "JELLYFIN", enabled: true, connectionGeneration: 8 });

		const result = await recordProviderCacheRefreshFailure(
			state.prisma as never,
			"instance-1",
			"plex",
			"old Plex failed",
			{ service: "PLEX", connectionGeneration: 7 },
			log,
		);

		expect(result).toBe("superseded");
		expect(state.tx.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("locks and revalidates the current PostgreSQL generation before recording failure", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://database.example.com/arr");
		const state = fixture({ service: "TAUTULLI", enabled: true, connectionGeneration: 4 });

		const result = await recordProviderCacheRefreshFailure(
			state.prisma as never,
			"instance-1",
			"tautulli",
			"request failed",
			{ service: "TAUTULLI", connectionGeneration: 4 },
			log,
		);

		expect(result).toBe("recorded");
		expect(state.order).toEqual(["lock", "identity", "failure"]);
		expect(state.tx.$queryRawUnsafe).toHaveBeenCalledWith(
			'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
			"instance-1",
		);
		expect(state.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), undefined);
	});
});
