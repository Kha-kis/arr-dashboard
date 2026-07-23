import { describe, expect, it, vi } from "vitest";
import { migrateUrlEmbeddedHttpAuth } from "../http-auth-migration.js";

describe("migrateUrlEmbeddedHttpAuth", () => {
	it("encrypts URL userinfo, strips it from the URL, and is scoped by owner", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const app = {
			prisma: {
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([
						{
							id: "service-1",
							userId: "user-1",
							baseUrl: "https://proxy%20user:p%40ss@example.test/qui",
							externalUrl: "https://browser:secret@public.example.test/qui",
							encryptedHttpAuthCredentials: null,
							httpAuthEncryptionIv: null,
						},
					]),
					updateMany,
				},
			},
			encryptor: { encrypt: vi.fn(() => ({ value: "encrypted", iv: "iv" })) },
			log: { info: vi.fn(), warn: vi.fn() },
		};

		await expect(migrateUrlEmbeddedHttpAuth(app as never)).resolves.toBe(1);
		expect(app.encryptor.encrypt).toHaveBeenCalledWith(
			JSON.stringify({ v: 1, username: "proxy user", password: "p@ss" }),
		);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: "service-1", userId: "user-1" },
			data: {
				baseUrl: "https://example.test/qui",
				externalUrl: "https://public.example.test/qui",
				encryptedHttpAuthCredentials: "encrypted",
				httpAuthEncryptionIv: "iv",
			},
		});
	});
});
