import { afterEach, describe, expect, it, vi } from "vitest";
import {
	providerConnectionIdentity,
	withCurrentProviderConnection,
} from "./provider-connection-guard.js";

afterEach(() => vi.unstubAllEnvs());

describe("withCurrentProviderConnection", () => {
	it("locks the PostgreSQL service row before reading it or publishing a guarded write", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://arr-dashboard.test/provider-cache");
		const calls: string[] = [];
		const connection = {
			service: "PLEX" as const,
			baseUrl: "https://plex.example.test",
			encryptedApiKey: "key",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			enabled: true,
			connectionGeneration: 4,
		};
		const tx = {
			$queryRawUnsafe: vi.fn(async () => {
				calls.push("lock");
				return [];
			}),
			serviceInstance: {
				findUnique: vi.fn(async () => {
					calls.push("read");
					return connection;
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
			providerConnectionIdentity(connection),
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

	it("rejects a restored row that reuses the id and generation for a different connection", async () => {
		const original = {
			service: "PLEX" as const,
			baseUrl: "https://old-plex.example.test",
			encryptedApiKey: "old-key",
			encryptionIv: "old-iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			connectionGeneration: 4,
		};
		const write = vi.fn();
		const tx = {
			serviceInstance: {
				findUnique: vi.fn().mockResolvedValue({
					...original,
					baseUrl: "https://restored-plex.example.test",
					encryptedApiKey: "restored-key",
					enabled: true,
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
			providerConnectionIdentity(original),
			write,
		);

		expect(result).toEqual({ matched: false });
		expect(write).not.toHaveBeenCalled();
	});
});
