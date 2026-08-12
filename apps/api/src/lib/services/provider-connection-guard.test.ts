import { afterEach, describe, expect, it, vi } from "vitest";
import { withCurrentProviderConnection } from "./provider-connection-guard.js";

afterEach(() => vi.unstubAllEnvs());

describe("withCurrentProviderConnection", () => {
	it("locks the PostgreSQL service row before reading it or publishing a guarded write", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://arr-dashboard.test/provider-cache");
		const calls: string[] = [];
		const tx = {
			$queryRawUnsafe: vi.fn(async () => {
				calls.push("lock");
				return [];
			}),
			serviceInstance: {
				findUnique: vi.fn(async () => {
					calls.push("read");
					return { service: "PLEX", enabled: true, connectionGeneration: 4 };
				}),
			},
		};
		const prisma = {
			$transaction: vi.fn(
				async (callback: (transaction: typeof tx) => Promise<unknown>) => await callback(tx),
			),
		};

		const result = await withCurrentProviderConnection(
			prisma as never,
			"plex-1",
			{ service: "PLEX", connectionGeneration: 4 },
			async () => {
				calls.push("write");
				return "published";
			},
		);

		expect(result).toEqual({ matched: true, value: "published" });
		expect(calls).toEqual(["lock", "read", "write"]);
		expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
			'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
			"plex-1",
		);
		expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			timeout: 120_000,
		});
	});
});
