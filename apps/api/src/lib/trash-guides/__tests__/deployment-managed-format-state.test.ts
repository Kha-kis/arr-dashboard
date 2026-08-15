import { describe, expect, it, vi } from "vitest";
import {
	captureManagedCustomFormatIdentities,
	parseManagedCustomFormatIdentities,
	readPersistedManagedCustomFormatIdentities,
	resolveOrphanedManagedCustomFormats,
} from "../deployment-managed-format-state.js";

const templateFormat = { trashId: "trash-1", name: "Foo" } as never;

describe("managed Custom Format identities", () => {
	it("captures the exact upstream ID and full-resource state", async () => {
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, name: "Foo" }]),
				getById: vi.fn().mockResolvedValue({ id: 7, name: "Foo", specifications: [] }),
			},
		};

		const result = await captureManagedCustomFormatIdentities(client as never, [templateFormat], {
			id: 3,
			formatItems: [{ format: 7, score: 100 }],
		});

		expect(result).toEqual([
			expect.objectContaining({
				trashId: "trash-1",
				name: "Foo",
				resourceId: 7,
				profileId: 3,
				appliedScore: 100,
			}),
		]);
		expect(result[0]?.stateToken).toEqual(expect.any(String));
	});

	it("fails closed when any deployed template format cannot be captured", async () => {
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				getById: vi.fn(),
			},
		};

		await expect(
			captureManagedCustomFormatIdentities(client as never, [templateFormat], {
				id: 3,
				formatItems: [],
			}),
		).rejects.toThrow("could not be captured");
	});

	it("resolves an unchanged removed format by ID", async () => {
		const full = { id: 7, name: "Foo", specifications: [] };
		const captured = await captureManagedCustomFormatIdentities(
			{
				customFormat: {
					getAll: vi.fn().mockResolvedValue([{ id: 7, name: "Foo" }]),
					getById: vi.fn().mockResolvedValue(full),
				},
			} as never,
			[templateFormat],
			{ id: 3, formatItems: [{ format: 7, score: 100 }] },
		);
		const result = await resolveOrphanedManagedCustomFormats(
			{
				customFormat: {
					getAll: vi.fn().mockResolvedValue([{ id: 7, name: "Foo" }]),
					getById: vi.fn().mockResolvedValue(full),
				},
			} as never,
			[],
			captured,
			{ id: 3, formatItems: [{ format: 7, score: 100 }] },
		);

		expect(result).toEqual({
			formats: [{ trashId: "trash-1", name: "Foo", resourceId: 7 }],
			warnings: [],
		});
	});

	it("refuses a same-name replacement at a different ID", async () => {
		const result = await resolveOrphanedManagedCustomFormats(
			{
				customFormat: {
					getAll: vi.fn().mockResolvedValue([{ id: 8, name: "Foo" }]),
					getById: vi.fn(),
				},
			} as never,
			[],
			[
				{
					trashId: "trash-1",
					name: "Foo",
					resourceId: 7,
					stateToken: "token",
					profileId: 3,
					appliedScore: 100,
				},
			],
			{ id: 3, formatItems: [{ format: 7, score: 100 }] },
		);

		expect(result).toEqual({ formats: [], warnings: [] });
	});

	it("preserves a manually changed upstream score when a format is removed", async () => {
		const full = { id: 7, name: "Foo", specifications: [] };
		const result = await resolveOrphanedManagedCustomFormats(
			{
				customFormat: {
					getAll: vi.fn().mockResolvedValue([{ id: 7, name: "Foo" }]),
					getById: vi.fn().mockResolvedValue(full),
				},
			} as never,
			[],
			[
				{
					trashId: "trash-1",
					name: "Foo",
					resourceId: 7,
					stateToken: "token",
					profileId: 3,
					appliedScore: 100,
				},
			],
			{ id: 3, formatItems: [{ format: 7, score: -10000 }] },
		);

		expect(result.formats).toEqual([]);
		expect(result.warnings).toEqual([expect.stringContaining("current score was preserved")]);
		expect(result.warnings[0]).toContain("Foo");
	});

	it("rejects malformed persisted identities", () => {
		expect(() =>
			parseManagedCustomFormatIdentities(
				JSON.stringify({
					managedCustomFormats: [
						{ trashId: "trash-1", name: "Foo", resourceId: 0, stateToken: "token" },
					],
				}),
			),
		).toThrow("incomplete");
	});

	it("fails closed when an existing mapping has no durable managed identity snapshot", () => {
		expect(() =>
			readPersistedManagedCustomFormatIdentities({
				managedCustomFormatsCaptured: false,
				managedCustomFormats: null,
			}),
		).toThrow("managed Custom Format identity snapshot is unavailable");
	});
});
