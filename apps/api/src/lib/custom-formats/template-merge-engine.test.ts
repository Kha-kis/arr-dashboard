/**
 * Template Merge Engine - Unit Tests
 * Tests for deterministic and idempotent CF merging
 */

import { describe, it, expect } from "vitest";
import {
	resolveTemplates,
	computeDiff,
	validateMergeContext,
	type CustomFormat,
	type Template,
	type MergeContext,
} from "./template-merge-engine.js";

describe("Template Merge Engine", () => {
	// ========================================================================
	// Test Data
	// ========================================================================

	const baseCF1: CustomFormat = {
		id: 1,
		name: "x264",
		includeCustomFormatWhenRenaming: false,
		specifications: [
			{
				name: "x264",
				implementation: "ReleaseTitleSpecification",
				fields: { value: "x264" },
			},
		],
	};

	const baseCF2: CustomFormat = {
		id: 2,
		name: "x265",
		includeCustomFormatWhenRenaming: false,
		specifications: [
			{
				name: "x265",
				implementation: "ReleaseTitleSpecification",
				fields: { value: "x265" },
			},
		],
	};

	const trashCF1: CustomFormat = {
		trash_id: "trash-anime",
		name: "Anime",
		specifications: [
			{
				name: "Anime",
				implementation: "ReleaseGroupSpecification",
				fields: { value: "SubsPlease|Erai-raws" },
			},
		],
	};

	const trashCF2: CustomFormat = {
		trash_id: "trash-x265",
		name: "x265 (HD)",
		specifications: [
			{
				name: "x265",
				implementation: "ReleaseTitleSpecification",
				fields: { value: "x265|HEVC" },
			},
		],
	};

	const template1: Template = {
		id: "trash-anime-template",
		name: "Anime Template",
		customFormats: [trashCF1],
	};

	const template2: Template = {
		id: "trash-video-template",
		name: "Video Codecs",
		customFormats: [trashCF2],
	};

	// ========================================================================
	// Phase 1: Base CFs (no changes)
	// ========================================================================

	it("should return base CFs when no templates included", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1, baseCF2],
			templates: [template1, template2],
			includes: [],
			excludes: [],
			overrides: {},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs).toHaveLength(2);
		expect(result.resolvedCFs[0]?.name).toBe("x264");
		expect(result.resolvedCFs[1]?.name).toBe("x265");
		expect(result.warnings).toHaveLength(0);
		expect(result.errors).toHaveLength(0);
	});

	// ========================================================================
	// Phase 2: Merge includes[] with last-win semantics
	// ========================================================================

	it("should merge templates in order (last-win)", () => {
		// Include both templates
		const context: MergeContext = {
			baseCFs: [baseCF1],
			templates: [template1, template2],
			includes: ["trash-anime-template", "trash-video-template"],
			excludes: [],
			overrides: {},
		};

		const result = resolveTemplates(context);

		// Should have base + 2 from templates
		expect(result.resolvedCFs).toHaveLength(3);
		expect(result.resolvedCFs.some((cf) => cf.name === "x264")).toBe(true);
		expect(result.resolvedCFs.some((cf) => cf.name === "Anime")).toBe(true);
		expect(result.resolvedCFs.some((cf) => cf.name === "x265 (HD)")).toBe(
			true,
		);
	});

	it("should override CFs with same trash_id (last-win)", () => {
		const templateA: Template = {
			id: "template-a",
			name: "Template A",
			customFormats: [
				{
					trash_id: "shared",
					name: "Version A",
					specifications: [],
				},
			],
		};

		const templateB: Template = {
			id: "template-b",
			name: "Template B",
			customFormats: [
				{
					trash_id: "shared",
					name: "Version B",
					specifications: [],
				},
			],
		};

		const context: MergeContext = {
			baseCFs: [],
			templates: [templateA, templateB],
			includes: ["template-a", "template-b"], // B wins
			excludes: [],
			overrides: {},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs).toHaveLength(1);
		expect(result.resolvedCFs[0]?.name).toBe("Version B"); // Last-win
	});

	it("should warn when template not found", () => {
		const context: MergeContext = {
			baseCFs: [],
			templates: [template1],
			includes: ["nonexistent-template"],
			excludes: [],
			overrides: {},
		};

		const result = resolveTemplates(context);

		expect(result.warnings).toContain(
			"Template not found: nonexistent-template",
		);
	});

	// ========================================================================
	// Phase 3: Remove excludes[]
	// ========================================================================

	it("should exclude CFs by trash_id", () => {
		const context: MergeContext = {
			baseCFs: [],
			templates: [template1, template2],
			includes: ["trash-anime-template", "trash-video-template"],
			excludes: ["trash-anime"], // Exclude anime
			overrides: {},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs).toHaveLength(1);
		expect(result.resolvedCFs[0]?.name).toBe("x265 (HD)"); // Only video CF
	});

	it("should exclude CFs by name", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1, baseCF2],
			templates: [],
			includes: [],
			excludes: ["x264"], // Exclude by name
			overrides: {},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs).toHaveLength(1);
		expect(result.resolvedCFs[0]?.name).toBe("x265"); // Only x265
	});

	it("should exclude CFs by local ID", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1, baseCF2],
			templates: [],
			includes: [],
			excludes: ["1"], // Exclude by local ID
			overrides: {},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs).toHaveLength(1);
		expect(result.resolvedCFs[0]?.name).toBe("x265"); // Only x265
	});

	// ========================================================================
	// Phase 4: Apply overrides{}
	// ========================================================================

	it("should apply name override", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1],
			templates: [],
			includes: [],
			excludes: [],
			overrides: {
				x264: { name: "x264 (Renamed)" },
			},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs[0]?.name).toBe("x264 (Renamed)");
	});

	it("should apply score override", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1],
			templates: [],
			includes: [],
			excludes: [],
			overrides: {
				x264: { score: 100 },
			},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs[0]?.score).toBe(100);
	});

	it("should apply tags override", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1],
			templates: [],
			includes: [],
			excludes: [],
			overrides: {
				x264: { tags: ["codec", "video"] },
			},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs[0]?.tags).toEqual(["codec", "video"]);
	});

	it("should apply spec override (deep merge)", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1],
			templates: [],
			includes: [],
			excludes: [],
			overrides: {
				x264: {
					spec: {
						value: "x264|AVC", // Merged with existing fields
						negate: true,
					},
				},
			},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs[0]?.specifications?.[0]?.fields?.value).toBe(
			"x264|AVC",
		);
		expect(result.resolvedCFs[0]?.specifications?.[0]?.fields?.negate).toBe(
			true,
		);
	});

	it("should apply quality profile link override", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1],
			templates: [],
			includes: [],
			excludes: [],
			overrides: {
				x264: {
					qualityProfileLinks: [
						{ profileId: "profile-1", score: 50 },
						{ profileId: "profile-2", score: 100 },
					],
				},
			},
		};

		const result = resolveTemplates(context);

		expect(result.resolvedCFs[0]?.qualityProfileLinks).toEqual([
			{ profileId: "profile-1", score: 50 },
			{ profileId: "profile-2", score: 100 },
		]);
	});

	// ========================================================================
	// Idempotency
	// ========================================================================

	it("should be idempotent (same input = same output)", () => {
		const context: MergeContext = {
			baseCFs: [baseCF1, baseCF2],
			templates: [template1, template2],
			includes: ["trash-anime-template"],
			excludes: ["x264"],
			overrides: {
				x265: { score: 50 },
			},
		};

		const result1 = resolveTemplates(context);
		const result2 = resolveTemplates(context);

		expect(result1.resolvedCFs).toEqual(result2.resolvedCFs);
		expect(result1.changes).toEqual(result2.changes);
	});

	// ========================================================================
	// computeDiff
	// ========================================================================

	it("should detect added CFs", () => {
		const oldCFs: CustomFormat[] = [];
		const newCFs: CustomFormat[] = [baseCF1];

		const changes = computeDiff(oldCFs, newCFs);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.changeType).toBe("added");
		expect(changes[0]?.name).toBe("x264");
	});

	it("should detect removed CFs", () => {
		const oldCFs: CustomFormat[] = [baseCF1];
		const newCFs: CustomFormat[] = [];

		const changes = computeDiff(oldCFs, newCFs);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.changeType).toBe("removed");
		expect(changes[0]?.name).toBe("x264");
	});

	it("should detect modified CFs", () => {
		const oldCFs: CustomFormat[] = [baseCF1];
		const newCFs: CustomFormat[] = [
			{ ...baseCF1, name: "x264 (Updated)", score: 100 },
		]; // Same id, different name/score

		const changes = computeDiff(oldCFs, newCFs);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.changeType).toBe("modified");
		expect(changes[0]?.changes).toContain(
			'Renamed: "x264" → "x264 (Updated)"',
		);
		expect(changes[0]?.changes).toContain("Score: 0 → 100");
	});

	it("should detect unchanged CFs", () => {
		const oldCFs: CustomFormat[] = [baseCF1];
		const newCFs: CustomFormat[] = [baseCF1];

		const changes = computeDiff(oldCFs, newCFs);

		expect(changes).toHaveLength(1);
		expect(changes[0]?.changeType).toBe("unchanged");
	});

	it("should sort changes deterministically (added, modified, removed, unchanged)", () => {
		const oldCFs: CustomFormat[] = [baseCF1, baseCF2];
		const newCFs: CustomFormat[] = [
			{ ...baseCF1, score: 100 }, // Modified (same id=1)
			trashCF1, // Added
		];

		const changes = computeDiff(oldCFs, newCFs);

		expect(changes).toHaveLength(3); // 1 added, 1 modified, 1 removed
		expect(changes[0]?.changeType).toBe("added"); // First: added
		expect(changes[1]?.changeType).toBe("modified"); // Second: modified
		expect(changes[2]?.changeType).toBe("removed"); // Third: removed (baseCF2)
	});

	// ========================================================================
	// Validation
	// ========================================================================

	it("should validate merge context", () => {
		const validContext: MergeContext = {
			baseCFs: [],
			templates: [],
			includes: [],
			excludes: [],
			overrides: {},
		};

		const result = validateMergeContext(validContext);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it("should reject invalid merge context", () => {
		const invalidContext = {
			baseCFs: "not an array",
			templates: [],
			includes: [],
			excludes: [],
			overrides: {},
		} as any;

		const result = validateMergeContext(invalidContext);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});
});
