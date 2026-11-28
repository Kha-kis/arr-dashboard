import type { CompleteQualityProfile } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArrClientFactory } from "../../arr/client-factory.js";
import type { PrismaClient } from "../../prisma.js";
import { ProfileCloner } from "../profile-cloner.js";

type Format = {
	id?: number;
	name: string;
	includeCustomFormatWhenRenaming: boolean;
	specifications: Array<{
		name: string;
		implementation: string;
		negate: boolean;
		required: boolean;
		fields: Array<{ name: string; value: unknown }>;
	}>;
};
const format = (id: number, name = "Selected CF"): Format => ({
	id,
	name,
	includeCustomFormatWhenRenaming: false,
	specifications: [
		{
			name: "Release",
			implementation: "ReleaseTitleSpecification",
			negate: false,
			required: true,
			fields: [
				{ name: "value", value: "synthetic" },
				{ name: "except", value: "foreign" },
			],
		},
	],
});

describe("clone live source-to-target resolution and complete replacement", () => {
	let cloner: ProfileCloner;
	let profile: CompleteQualityProfile;
	let sourceFormats: Format[], targetFormats: Format[];
	let sourceProfile: {
		id: number;
		name: string;
		formatItems: Array<{ format: number; score: number }>;
	};
	let liveTarget: Record<string, unknown>;
	let selections: Array<{ trash_id: string; score: number }>;
	let instances: Array<{
		id: string;
		userId: string;
		service: string;
		enabled: boolean;
		baseUrl: string;
		encryptedApiKey: string;
		label: string;
	}>;
	let sourceGet: ReturnType<typeof vi.fn>, targetGet: ReturnType<typeof vi.fn>;
	let update: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		profile = {
			sourceInstanceId: "source",
			sourceProfileId: 7,
			sourceProfileName: "Reviewed source",
			importedAt: "2026-10-25T00:00:00Z",
			upgradeAllowed: true,
			cutoff: 1,
			items: [{ quality: { id: 1, name: "HDTV-720p" }, allowed: true }],
			minFormatScore: -10,
			cutoffFormatScore: 500,
		};
		sourceFormats = [format(42)];
		targetFormats = [format(142), format(143, "Unselected CF")];
		sourceProfile = {
			id: 7,
			name: "Live owned source",
			formatItems: [{ format: 42, score: -10000 }],
		};
		liveTarget = {
			id: 70,
			name: "Live target",
			minUpgradeFormatScore: 77,
			language: { id: 1, name: "English" },
			unknownFutureField: { retained: true },
			formatItems: [{ format: 143, score: 3 }],
		};
		instances = ["source", "target"].map((id) => ({
			id,
			userId: "owner",
			service: "SONARR",
			enabled: true,
			baseUrl: `http://synthetic.invalid/${id}`,
			encryptedApiKey: "synthetic",
			label: id,
		}));
		selections = [{ trash_id: "Selected CF", score: -10000 }];
		sourceGet = vi.fn(async () => structuredClone(sourceProfile));
		targetGet = vi.fn(async () => structuredClone(liveTarget));
		update = vi.fn(async (_id: number, body: Record<string, unknown>) => structuredClone(body));
		create = vi.fn(async (body: Record<string, unknown>) => ({ ...structuredClone(body), id: 80 }));
		const clients = {
			source: {
				qualityProfile: { getById: sourceGet },
				customFormat: { getAll: async () => structuredClone(sourceFormats) },
			},
			target: {
				qualityProfile: { getById: targetGet, update, create },
				customFormat: { getAll: async () => structuredClone(targetFormats) },
			},
		};
		const prisma = {
			serviceInstance: {
				findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
					instances.find((i) => i.id === where.id && i.userId === where.userId) ?? null,
			},
		} as unknown as PrismaClient;
		const factory = {
			create: (instance: { id: string }) => clients[instance.id as keyof typeof clients],
		} as unknown as ArrClientFactory;
		cloner = new ProfileCloner(prisma, factory);
	});
	const deploy = () =>
		cloner.deployCompleteProfile("target", "owner", profile, selections, {
			profileName: "Explicit clone",
			existingProfileId: 70,
		});
	const preview = () => cloner.previewProfileDeployment("target", "owner", profile, selections);
	const noWrite = () => {
		expect(update).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	};
	const unmatched = async () => {
		const result = await preview();
		expect(result).toMatchObject({
			success: true,
			preview: { customFormats: { total: 1, matched: 0, unmatched: ["Selected CF"] } },
		});
		expect(await deploy()).toMatchObject({
			success: false,
			error: expect.stringMatching(/refresh|review|template/i),
		});
		noWrite();
	};
	it("uses one complete live name-and-definition mapping and preserves omitted optional target fields", async () => {
		targetFormats[0]!.specifications[0]!.fields.reverse();
		expect(await preview()).toMatchObject({
			success: true,
			preview: { customFormats: { matched: 1, unmatched: [] } },
		});
		noWrite();
		expect(await deploy()).toEqual({ success: true, profileId: 70 });
		expect(targetGet).toHaveBeenCalledWith(70);
		expect(update).toHaveBeenCalledExactlyOnceWith(
			70,
			expect.objectContaining({
				id: 70,
				name: "Explicit clone",
				formatItems: [{ format: 142, score: -10000 }],
				minUpgradeFormatScore: 77,
				language: { id: 1, name: "English" },
				unknownFutureField: { retained: true },
			}),
		);
	});
	it("preserves unique exact trash markers after owned source authorization", async () => {
		for (const cf of [sourceFormats[0]!, targetFormats[0]!])
			cf.specifications[0]!.fields.push({ name: "trash_id", value: "exact-trash" });
		targetFormats[0]!.name = "Renamed exact marker";
		selections = [{ trash_id: "exact-trash", score: 0 }];
		expect(await deploy()).toEqual({ success: true, profileId: 70 });
		expect(update.mock.calls[0]![1]).toMatchObject({ formatItems: [{ format: 142, score: 0 }] });
	});
	it("explicit optional source values override live values including zero", async () => {
		profile.minUpgradeFormatScore = 0;
		profile.language = { id: 2, name: "French" };
		expect(await deploy()).toMatchObject({ success: true });
		expect(update.mock.calls[0]![1]).toMatchObject({
			minUpgradeFormatScore: 0,
			language: { id: 2, name: "French" },
		});
	});
	it.each([
		"ambiguous-target",
		"ambiguous-source",
		"changed-spec",
		"extra-field",
		"renaming",
		"missing",
	])("refuses %s name correlation before mutation", async (variant) => {
		if (variant === "ambiguous-target") targetFormats.push(format(144));
		if (variant === "ambiguous-source") {
			sourceFormats.push(format(44));
			sourceProfile.formatItems.push({ format: 44, score: 0 });
		}
		if (variant === "changed-spec")
			targetFormats[0]!.specifications[0]!.fields[0]!.value = "changed";
		if (variant === "extra-field")
			targetFormats[0]!.specifications[0]!.fields.push({ name: "additional", value: true });
		if (variant === "renaming") targetFormats[0]!.includeCustomFormatWhenRenaming = true;
		if (variant === "missing") targetFormats = [];
		await unmatched();
	});
	it("does not use an unrelated source CF that is absent from the live source profile", async () => {
		sourceProfile.formatItems = [];
		await unmatched();
	});
	it("re-resolves execution after preview drift and refuses the stale target correlation", async () => {
		expect(await preview()).toMatchObject({
			success: true,
			preview: { customFormats: { matched: 1 } },
		});
		targetFormats[0]!.specifications[0]!.fields[0]!.value = "drift";
		expect(await deploy()).toMatchObject({ success: false });
		noWrite();
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined])(
		"rejects unsafe target CF id %s without a write",
		async (id) => {
			targetFormats[0]!.id = id;
			expect(await deploy()).toMatchObject({ success: false });
			noWrite();
		},
	);
	it.each([
		"source-id",
		"source-profile-id",
		"source-profile-mismatch",
		"duplicate-id",
		"duplicate-selection",
		"conflicting-aliases",
		"nonfinite-score",
		"duplicate-marker",
	])("rejects %s identity or selection conflict", async (variant) => {
		if (variant === "source-id") sourceFormats[0]!.id = 0;
		if (variant === "source-profile-id") profile.sourceProfileId = 0;
		if (variant === "source-profile-mismatch") sourceProfile.id = 8;
		if (variant === "duplicate-id") targetFormats.push(format(142, "Different CF"));
		if (variant === "duplicate-selection") selections.push({ trash_id: "Selected CF", score: 10 });
		if (variant === "conflicting-aliases") {
			for (const cf of [sourceFormats[0]!, targetFormats[0]!])
				cf.specifications[0]!.fields.push({ name: "trash_id", value: "exact-trash" });
			selections.push({ trash_id: "exact-trash", score: 10 });
		}
		if (variant === "nonfinite-score") selections[0]!.score = Number.NaN;
		if (variant === "duplicate-marker") {
			for (const cf of [sourceFormats[0]!, targetFormats[0]!, targetFormats[1]!])
				cf.specifications[0]!.fields.push({ name: "trash_id", value: "exact-trash" });
			selections = [{ trash_id: "exact-trash", score: 1 }];
		}
		expect(await deploy()).toMatchObject({ success: false });
		noWrite();
	});
	it.each([
		"missing-source",
		"foreign-source",
		"disabled-source",
		"disabled-target",
		"wrong-service",
		"unsupported-target",
	])("refuses %s connection authority", async (variant) => {
		if (variant === "missing-source") profile.sourceInstanceId = "missing";
		if (variant === "foreign-source") instances[0]!.userId = "other";
		if (variant === "disabled-source") instances[0]!.enabled = false;
		if (variant === "disabled-target") instances[1]!.enabled = false;
		if (variant === "wrong-service") instances[0]!.service = "RADARR";
		if (variant === "unsupported-target") instances[1]!.service = "LIDARR";
		expect(await deploy()).toMatchObject({ success: false });
		noWrite();
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"refuses invalid existing id %s rather than falling through to create",
		async (existingProfileId) => {
			expect(
				await cloner.deployCompleteProfile("target", "owner", profile, selections, {
					profileName: "Explicit clone",
					existingProfileId,
				}),
			).toMatchObject({ success: false });
			noWrite();
		},
	);
	it.each(["get-refusal", "get-wrong-id", "get-unsafe-id"])(
		"refuses %s target read before PUT",
		async (variant) => {
			if (variant === "get-refusal")
				targetGet.mockRejectedValue(new Error("synthetic read refused"));
			if (variant === "get-wrong-id") liveTarget.id = 71;
			if (variant === "get-unsafe-id") liveTarget.id = 0;
			expect(await deploy()).toMatchObject({ success: false });
			noWrite();
		},
	);
	it("supports defined-field create without a fake target read", async () => {
		expect(
			await cloner.deployCompleteProfile("target", "owner", profile, selections, {
				profileName: "New clone",
			}),
		).toEqual({ success: true, profileId: 80 });
		expect(targetGet).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledOnce();
		expect(create.mock.calls[0]![0]).toMatchObject({
			name: "New clone",
			formatItems: [{ format: 142, score: -10000 }],
		});
		expect(create.mock.calls[0]![0]).not.toHaveProperty("minUpgradeFormatScore");
	});
	it.each(["create", "update"])(
		"does not claim success or replay %s after an invalid returned identity",
		async (mode) => {
			if (mode === "create") create.mockResolvedValue({ id: 0 });
			else update.mockResolvedValue({ id: 71 });
			expect(
				await cloner.deployCompleteProfile("target", "owner", profile, selections, {
					profileName: "Clone",
					...(mode === "update" ? { existingProfileId: 70 } : {}),
				}),
			).toMatchObject({ success: false });
			expect(create.mock.calls.length + update.mock.calls.length).toBe(1);
		},
	);
	it("reports selected provider refusal without succeeding or retrying", async () => {
		update.mockRejectedValue(new Error("synthetic provider422"));
		expect(await deploy()).toMatchObject({ success: false, error: "synthetic provider422" });
		expect(update).toHaveBeenCalledOnce();
		expect(create).not.toHaveBeenCalled();
	});
});
