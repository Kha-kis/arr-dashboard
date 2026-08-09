import type { TrashCustomFormat } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { AppValidationError, ConflictError } from "../../errors.js";
import { buildCustomFormatsConfig } from "../profile-matcher.js";
import { calculateScoreAndSource } from "../template-score-utils.js";

const instanceFormats = new Map([
	[
		42,
		{
			id: 42,
			name: "Language: Not English",
			specifications: [{ name: "Not English" }],
		},
	],
]);

function keepInstanceSelection(scoreOverride?: number) {
	return {
		"instance-42": {
			selected: true,
			scoreOverride,
			conditionsEnabled: {},
		},
	};
}

describe("buildCustomFormatsConfig", () => {
	it("preserves the current source profile score for a Keep Instance selection", () => {
		const result = buildCustomFormatsConfig(
			keepInstanceSelection(),
			instanceFormats,
			new Map<string, TrashCustomFormat>(),
			"radarr-1",
			new Map([[42, -10_000]]),
		);

		expect(result).toEqual([
			expect.objectContaining({
				trashId: "instance-42",
				name: "Language: Not English",
				scoreOverride: -10_000,
			}),
		]);
		expect(calculateScoreAndSource(result[0]!, undefined)).toEqual({
			score: -10_000,
			scoreSource: "template override",
		});
	});

	it("keeps an explicit user score of zero instead of replacing it with the source score", () => {
		const result = buildCustomFormatsConfig(
			keepInstanceSelection(0),
			instanceFormats,
			new Map<string, TrashCustomFormat>(),
			"sonarr-1",
			new Map([[42, -10_000]]),
		);

		expect(result[0]?.scoreOverride).toBe(0);
	});

	it("fails closed when the source profile no longer contains the selected format score", () => {
		for (const selection of [keepInstanceSelection(), keepInstanceSelection(500)]) {
			expect(() =>
				buildCustomFormatsConfig(
					selection,
					instanceFormats,
					new Map<string, TrashCustomFormat>(),
					"radarr-1",
					new Map(),
				),
			).toThrow(ConflictError);
		}
	});

	it("fails closed when the selected instance format no longer exists", () => {
		expect(() =>
			buildCustomFormatsConfig(
				keepInstanceSelection(),
				new Map(),
				new Map<string, TrashCustomFormat>(),
				"radarr-1",
				new Map([[42, -10_000]]),
			),
		).toThrow(ConflictError);
	});

	it("fails closed when a selected TRaSH-linked format no longer exists", () => {
		expect(() =>
			buildCustomFormatsConfig(
				{ "trash-missing": { selected: true, conditionsEnabled: {} } },
				instanceFormats,
				new Map<string, TrashCustomFormat>(),
				"radarr-1",
				new Map([[42, -10_000]]),
			),
		).toThrow(ConflictError);
	});

	it.each(["instance-42-stale", "instance-042", "instance-0", "instance--42"])(
		"rejects non-canonical instance format key %s",
		(cfKey) => {
			expect(() =>
				buildCustomFormatsConfig(
					{ [cfKey]: { selected: true, conditionsEnabled: {} } },
					instanceFormats,
					new Map<string, TrashCustomFormat>(),
					"radarr-1",
					new Map([[42, -10_000]]),
				),
			).toThrow(AppValidationError);
		},
	);

	it("reserves the instance namespace even if a cached TRaSH ID collides", () => {
		const collidingTrashFormat = {
			trash_id: "instance-42",
			name: "Wrong cached format",
			specifications: [],
		} as unknown as TrashCustomFormat;

		const result = buildCustomFormatsConfig(
			keepInstanceSelection(),
			instanceFormats,
			new Map([["instance-42", collidingTrashFormat]]),
			"radarr-1",
			new Map([[42, -10_000]]),
		);

		expect(result[0]).toEqual(
			expect.objectContaining({ name: "Language: Not English", scoreOverride: -10_000 }),
		);
	});
});
