import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Encryptor } from "../../lib/auth/encryption.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { refreshScheduledTautulliCacheInstance } from "../tautulli-cache-scheduler.js";

describe("Tautulli scheduler privacy boundary", () => {
	it("keeps a durable begin-attempt failure generic across the real scheduler path", async () => {
		const privateValues = [
			"PRIVATE_INSTANCE_ID",
			"PRIVATE_USER_ID",
			"PRIVATE_INSTANCE_LABEL",
			"https://PRIVATE_INSTANCE_URL.invalid",
			"PRIVATE_CREDENTIAL_SHAPED_MATERIAL",
			"PRIVATE_ENCRYPTED_CREDENTIAL",
			"PRIVATE_CREDENTIAL_IV",
			"PRIVATE_EXPECTED_IDENTITY",
			"PRIVATE_RAW_DATABASE_FAILURE",
			"PRIVATE_ATTEMPT_TOKEN",
		];
		const warn = vi.fn();
		const info = vi.fn();
		const error = vi.fn();
		const log = {
			warn,
			info,
			error,
			debug: vi.fn(),
		} as unknown as FastifyBaseLogger;
		const decrypt = vi.fn(() => privateValues[4]);
		const app = {
			prisma: {
				$transaction: vi
					.fn()
					.mockRejectedValue(new Error(`${privateValues[8]} token=${privateValues[9]}`)),
			},
			encryptor: { decrypt } as unknown as Encryptor,
			log,
		};
		const instance = {
			id: privateValues[0],
			userId: privateValues[1],
			service: "TAUTULLI",
			label: privateValues[2],
			baseUrl: privateValues[3],
			enabled: true,
			encryptedApiKey: privateValues[5],
			encryptionIv: privateValues[6],
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			expectedIdentity: privateValues[7],
			identityStatus: "VERIFIED",
			connectionGeneration: 4,
			identityGeneration: 9,
		} as unknown as ServiceInstance;

		await expect(
			refreshScheduledTautulliCacheInstance(app as never, instance),
		).resolves.toBeUndefined();
		expect(decrypt).not.toHaveBeenCalled();

		const loggerCalls = JSON.stringify([
			...warn.mock.calls,
			...info.mock.calls,
			...error.mock.calls,
		]);
		for (const privateValue of privateValues) {
			expect(loggerCalls).not.toContain(privateValue);
		}
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "tautulli",
				outcome: "unpublished",
				errors: 1,
			}),
			expect.any(String),
		);
	});
});
