import type { ProwlarrClient } from "arr-sdk/prowlarr";
import { ArrError } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	IndexerUpdateDispatchError,
	IndexerUpdateRejectedError,
	updateProwlarrIndexerWithSdk,
} from "../prowlarr-api.js";

const editableChanges = (fields: Array<{ name: string; value: string }>) => ({
	enable: false,
	priority: 8,
	fields,
});

const makeClient = (current: unknown) => {
	const getById = vi.fn().mockResolvedValue(current);
	const update = vi.fn().mockResolvedValue(current);
	return {
		client: { indexer: { getById, update } } as unknown as ProwlarrClient,
		getById,
		update,
	};
};

describe("Prowlarr indexer update boundary", () => {
	it("fetches the exact target and preserves provider-owned and sensitive fields", async () => {
		const current = {
			id: 7,
			name: "provider name",
			implementation: "provider-owned implementation",
			enable: true,
			priority: 2,
			fields: [
				{ name: "host", type: "textbox", value: "old", providerMetadata: "retain" },
				{ name: "apiKey", type: "password", value: "provider-secret" },
			],
		};
		const { client, getById, update } = makeClient(current);
		await updateProwlarrIndexerWithSdk(
			client,
			7,
			editableChanges([{ name: "host", value: "new" }]),
		);
		expect(getById).toHaveBeenCalledOnce();
		expect(getById).toHaveBeenCalledWith(7);
		expect(update).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledWith(7, {
			...current,
			enable: false,
			priority: 8,
			fields: [
				{ name: "host", type: "textbox", value: "new", providerMetadata: "retain" },
				{ name: "apiKey", type: "password", value: "provider-secret" },
			],
		});
	});

	it("fails closed when the provider returns a different target", async () => {
		const { client, update } = makeClient({ id: 8, name: "other" });
		await expect(updateProwlarrIndexerWithSdk(client, 7, editableChanges([]))).rejects.toThrow(
			/identity/i,
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("fails closed on unknown editable field names", async () => {
		const { client, update } = makeClient({
			id: 7,
			name: "provider name",
			fields: [{ name: "host", value: "old" }],
		});
		await expect(
			updateProwlarrIndexerWithSdk(
				client,
				7,
				editableChanges([{ name: "unexpected", value: "forged" }]),
			),
		).rejects.toThrow(/field/i);
		expect(update).not.toHaveBeenCalled();
	});

	it("rejects a changed sensitive field", async () => {
		const { client, update } = makeClient({
			id: 7,
			name: "provider name",
			fields: [{ name: "apiKey", type: "password", value: "provider-secret" }],
		});
		await expect(
			updateProwlarrIndexerWithSdk(
				client,
				7,
				editableChanges([{ name: "apiKey", value: "forged" }]),
			),
		).rejects.toThrow(/not editable/i);
		expect(update).not.toHaveBeenCalled();
	});

	it("dispatches the PUT once and marks a lost response unknown", async () => {
		const { client, update } = makeClient({ id: 7, name: "provider name" });
		update.mockRejectedValueOnce(new Error("connection reset after dispatch"));
		await expect(updateProwlarrIndexerWithSdk(client, 7, { enable: false })).rejects.toBeInstanceOf(
			IndexerUpdateDispatchError,
		);
		expect(update).toHaveBeenCalledOnce();
	});

	it.each([400, 401, 403, 404, 409])(
		"keeps a definite provider %i rejection distinct from an ambiguous write",
		async (statusCode) => {
			const { client, update } = makeClient({ id: 7, name: "synthetic" });
			update.mockRejectedValueOnce(new ArrError("synthetic rejection", statusCode));
			await expect(
				updateProwlarrIndexerWithSdk(client, 7, { enable: false }),
			).rejects.toBeInstanceOf(IndexerUpdateRejectedError);
			expect(update).toHaveBeenCalledOnce();
		},
	);
});
