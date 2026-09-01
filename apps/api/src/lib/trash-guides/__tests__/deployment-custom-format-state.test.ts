import { describe, expect, it, vi } from "vitest";
import {
	type CustomFormatRollbackState,
	createIntendedCustomFormatPostStateToken,
	matchesIntendedCustomFormatPostStateToken,
	rollbackCustomFormatDeployment,
} from "../deployment-custom-format-state.js";
import { createUpstreamResourceStateToken } from "../deployment-target.js";

const appliedState = (
	overrides: Partial<CustomFormatRollbackState> = {},
): CustomFormatRollbackState => ({
	beforeFormat: null,
	action: "created",
	resourceId: 7,
	name: "Created CF",
	status: "applied",
	postStateToken: createUpstreamResourceStateToken({
		id: 7,
		name: "Created CF",
		specifications: [],
	}),
	intendedPostStateToken: null,
	...overrides,
});

function completeSpecification(name: string) {
	return {
		name,
		implementation: "ReleaseTitleSpecification",
		negate: false,
		required: false,
		fields: [{ name: "value", type: "textbox", value: name }],
	};
}

describe("rollbackCustomFormatDeployment", () => {
	it("retains an unchanged created Custom Format when deletion has no conditional boundary", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
			qualityProfile: { getAll: vi.fn().mockResolvedValue([]) },
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"cannot be deleted safely",
		);
		expect(remove).not.toHaveBeenCalled();
	});

	it("refuses to delete a created Custom Format that changed after deployment", async () => {
		const changed = { id: 7, name: "Operator CF", specifications: [] };
		const remove = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([changed]),
				getById: vi.fn().mockResolvedValue(changed),
				delete: remove,
			},
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"changed after deployment",
		);
		expect(remove).not.toHaveBeenCalled();
	});

	it("refuses to delete an unchanged created Custom Format reused by a live profile", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
			qualityProfile: {
				getAll: vi
					.fn()
					.mockResolvedValue([{ id: 3, name: "Manually reused", formatItems: [{ format: 7 }] }]),
			},
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"referenced by quality profile",
		);
		expect(remove).not.toHaveBeenCalled();
	});

	it("fetches a complete profile when a partial listing omits formatItems", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn();
		const getProfileById = vi.fn().mockResolvedValue({
			id: 3,
			name: "Manually reused",
			formatItems: [{ format: 7, score: 100 }],
		});
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([{ id: 3, name: "Manually reused" }]),
				getById: getProfileById,
			},
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"referenced by quality profile",
		);
		expect(getProfileById).toHaveBeenCalledWith(3);
		expect(remove).not.toHaveBeenCalled();
	});

	it("fails closed when a full profile still has no complete Custom Format reference list", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				delete: remove,
			},
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([{ id: 3, name: "Incomplete" }]),
				getById: vi.fn().mockResolvedValue({ id: 3, name: "Incomplete", formatItems: null }),
			},
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"reference list could not be established",
		);
		expect(remove).not.toHaveBeenCalled();
	});

	it("re-checks exact Custom Format identity after profile reference checks", async () => {
		const deployed = { id: 7, name: "Created CF", specifications: [] };
		const changed = { id: 7, name: "Created CF", specifications: [{ name: "operator edit" }] };
		const remove = vi.fn();
		const getById = vi.fn().mockResolvedValueOnce(deployed).mockResolvedValueOnce(changed);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById,
				delete: remove,
			},
			qualityProfile: { getAll: vi.fn().mockResolvedValue([]) },
		};

		await expect(rollbackCustomFormatDeployment(client as never, appliedState())).rejects.toThrow(
			"changed after deployment",
		);
		expect(getById).toHaveBeenCalledTimes(2);
		expect(remove).not.toHaveBeenCalled();
	});

	it("retains an updated Custom Format when restoration has no conditional boundary", async () => {
		const before = {
			id: 4,
			name: "Existing CF",
			specifications: [completeSpecification("old")],
			includeCustomFormatWhenRenaming: false,
		};
		const deployed = { id: 4, name: "Existing CF", specifications: [{ name: "new" }] };
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValueOnce(deployed).mockResolvedValueOnce(before),
				update,
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat: before,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					postStateToken: createUpstreamResourceStateToken(deployed),
				}),
			),
		).rejects.toThrow("cannot be restored safely");
		expect(update).not.toHaveBeenCalled();
	});

	it.each([
		["incomplete", { id: 4, name: "Existing CF" }],
		[
			"malformed nested specification",
			{
				id: 4,
				name: "Existing CF",
				specifications: [{}],
				includeCustomFormatWhenRenaming: false,
			},
		],
		[
			"cross-wired",
			{
				id: 9,
				name: "Existing CF",
				specifications: [],
				includeCustomFormatWhenRenaming: false,
			},
		],
	] as const)("rejects a %s persisted Custom Format snapshot", async (_label, beforeFormat) => {
		const deployed = { id: 4, name: "Existing CF", specifications: [{ name: "new" }] };
		const update = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([deployed]),
				getById: vi.fn().mockResolvedValue(deployed),
				update,
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					postStateToken: createUpstreamResourceStateToken(deployed),
				}),
			),
		).rejects.toThrow("pre-deployment state");
		expect(update).not.toHaveBeenCalled();
	});

	it("treats a pending update still at its before-state as an idempotent no-op", async () => {
		const before = {
			id: 4,
			name: "Existing CF",
			specifications: [],
			includeCustomFormatWhenRenaming: false,
		};
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([before]),
				getById: vi.fn().mockResolvedValue(before),
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat: before,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					status: "pending",
					postStateToken: null,
				}),
			),
		).resolves.toBe("noop");
	});

	it("fails closed when a pending write left an unknown current state", async () => {
		const before = {
			id: 4,
			name: "Existing CF",
			specifications: [],
			includeCustomFormatWhenRenaming: false,
		};
		const changed = { ...before, specifications: [{ name: "unknown" }] };
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([changed]),
				getById: vi.fn().mockResolvedValue(changed),
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					beforeFormat: before,
					action: "updated",
					resourceId: 4,
					name: "Existing CF",
					status: "pending",
					postStateToken: null,
				}),
			),
		).rejects.toThrow("unverified deployment state");
	});

	it("retains a pending update when restoration has no conditional boundary", async () => {
		const before = {
			id: 4,
			name: "Existing CF",
			specifications: [completeSpecification("old")],
			includeCustomFormatWhenRenaming: false,
		};
		const intended = { id: 4, name: "Existing CF", specifications: [{ name: "new" }] };
		const update = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([intended]),
				getById: vi.fn().mockResolvedValueOnce(intended).mockResolvedValueOnce(before),
				update,
			},
		};
		const state = {
			...appliedState({
				beforeFormat: before,
				action: "updated",
				resourceId: 4,
				name: "Existing CF",
				status: "pending",
				postStateToken: null,
			}),
			intendedPostStateToken: createUpstreamResourceStateToken(intended),
		};

		await expect(rollbackCustomFormatDeployment(client as never, state)).rejects.toThrow(
			"cannot be restored safely",
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("retains a pending create when its exact returned state cannot be conditionally deleted", async () => {
		const created = { id: 7, name: "Created CF", specifications: [] };
		const remove = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([created]),
				getById: vi.fn().mockResolvedValue(created),
				delete: remove,
			},
			qualityProfile: { getAll: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					status: "pending",
					postStateToken: createUpstreamResourceStateToken(created),
				}),
			),
		).rejects.toThrow("cannot be deleted safely");
		expect(remove).not.toHaveBeenCalled();
	});

	it("keeps an unknown-ID create unresolved when the resource may have been renamed", async () => {
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 12, name: "Renamed after create" }]),
			},
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					action: "created",
					resourceId: null,
					name: "Created CF",
					status: "pending",
					postStateToken: null,
				}),
			),
		).rejects.toThrow("ID is unknown");
	});
});

describe("Custom Format intended post-state tokens", () => {
	const intended = {
		id: 7,
		name: "Created CF",
		includeCustomFormatWhenRenaming: false,
		specifications: [
			{
				name: "Language: Not English",
				implementation: "LanguageSpecification",
				negate: true,
				required: false,
				fields: [{ name: "value", value: 1 }],
			},
		],
	};
	const metadataRichSonarrReadback = {
		...intended,
		specifications: [
			{
				...intended.specifications[0],
				id: 12,
				implementationName: "Language",
				infoLink: "https://example.invalid/language",
				fields: [
					{ name: "value", value: 1, order: 0, label: "Language", type: "select" },
					{
						name: "exceptLanguage",
						value: false,
						order: 1,
						label: "Except language",
						type: "checkbox",
					},
				],
			},
		],
	};

	it("recognizes an exact state and Sonarr's one omitted false default despite readback metadata", () => {
		const token = createIntendedCustomFormatPostStateToken(intended, "SONARR");
		expect(matchesIntendedCustomFormatPostStateToken(intended, token)).toBe(true);
		expect(matchesIntendedCustomFormatPostStateToken(metadataRichSonarrReadback, token)).toBe(true);
	});

	it("does not apply the Sonarr exception to a Radarr recovery token", () => {
		const token = createIntendedCustomFormatPostStateToken(intended, "RADARR");
		expect(matchesIntendedCustomFormatPostStateToken(metadataRichSonarrReadback, token)).toBe(
			false,
		);
	});

	it("fails closed for legacy and malformed intended-state shapes", () => {
		const token = createIntendedCustomFormatPostStateToken(intended, "SONARR");
		expect(
			matchesIntendedCustomFormatPostStateToken(
				intended,
				token.replace("custom-format-writable-v2", "custom-format-writable-v1"),
			),
		).toBe(false);

		const malformedShapeToken = token.split(":");
		malformedShapeToken[3] = "not*base64url";
		expect(matchesIntendedCustomFormatPostStateToken(intended, malformedShapeToken.join(":"))).toBe(
			false,
		);
	});

	it("never lets intended writable evidence override a different exact post-state token", async () => {
		const current = {
			...metadataRichSonarrReadback,
			specifications: [
				{
					...metadataRichSonarrReadback.specifications[0],
					infoLink: "https://example.invalid/changed-metadata",
				},
			],
		};
		const qualityProfileGetAll = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([current]),
				getById: vi.fn().mockResolvedValue(current),
			},
			qualityProfile: { getAll: qualityProfileGetAll },
		};

		await expect(
			rollbackCustomFormatDeployment(
				client as never,
				appliedState({
					status: "pending",
					postStateToken: createUpstreamResourceStateToken(metadataRichSonarrReadback),
					intendedPostStateToken: createIntendedCustomFormatPostStateToken(intended, "SONARR"),
				}),
			),
		).rejects.toThrow("unverified deployment state");
		expect(qualityProfileGetAll).not.toHaveBeenCalled();
	});

	it("does not remove a false field when the intent explicitly defines exceptLanguage=true", () => {
		const explicitTrue = {
			...intended,
			specifications: [
				{
					...intended.specifications[0],
					fields: [...intended.specifications[0]!.fields, { name: "exceptLanguage", value: true }],
				},
			],
		};
		const conflictingReadback = {
			...explicitTrue,
			specifications: [
				{
					...explicitTrue.specifications[0],
					fields: [
						{ name: "value", value: 1 },
						{ name: "exceptLanguage", value: false },
						{ name: "exceptLanguage", value: true },
					],
				},
			],
		};
		const token = createIntendedCustomFormatPostStateToken(explicitTrue, "SONARR");
		expect(matchesIntendedCustomFormatPostStateToken(conflictingReadback, token)).toBe(false);
	});

	it("rejects real writable drift even when server metadata is present", () => {
		const token = createIntendedCustomFormatPostStateToken(intended, "SONARR");
		const drifted = {
			...metadataRichSonarrReadback,
			specifications: [
				{
					...metadataRichSonarrReadback.specifications[0],
					fields: [
						{ name: "value", value: 2, order: 0, label: "Language", type: "select" },
						metadataRichSonarrReadback.specifications[0]!.fields[1],
					],
				},
			],
		};
		expect(matchesIntendedCustomFormatPostStateToken(drifted, token)).toBe(false);
	});

	it.each([
		["implementationName", { implementationName: "Changed implementation" }, {}],
		["field label", {}, { label: "Changed label" }],
		["field type", {}, { type: "text" }],
	])(
		"rejects drift in an explicitly intended %s after Sonarr materializes a default",
		(_label, specificationDrift, fieldDrift) => {
			const intendedWithMetadata = {
				...intended,
				specifications: [
					{
						...intended.specifications[0],
						implementationName: "Intended implementation",
						fields: [
							{
								...intended.specifications[0]!.fields[0],
								label: "Intended label",
								type: "select",
							},
						],
					},
				],
			};
			const token = createIntendedCustomFormatPostStateToken(intendedWithMetadata, "SONARR");
			const metadataRichReadback = {
				...intendedWithMetadata,
				specifications: [
					{
						...intendedWithMetadata.specifications[0],
						...specificationDrift,
						fields: [
							{
								...intendedWithMetadata.specifications[0]!.fields[0],
								...fieldDrift,
							},
							{ name: "exceptLanguage", value: false, type: "checkbox" },
						],
					},
				],
			};

			const unchangedReadback = {
				...metadataRichReadback,
				specifications: [
					{
						...intendedWithMetadata.specifications[0],
						fields: [
							intendedWithMetadata.specifications[0]!.fields[0],
							{ name: "exceptLanguage", value: false, type: "checkbox" },
						],
					},
				],
			};
			expect(matchesIntendedCustomFormatPostStateToken(unchangedReadback, token)).toBe(true);
			expect(matchesIntendedCustomFormatPostStateToken(metadataRichReadback, token)).toBe(false);
		},
	);
});
