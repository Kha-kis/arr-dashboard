/**
 * qui-display vocabulary tests (Phase 1.4 / 2.1)
 *
 * Pins the labels and tones returned by `describeQuiState`, which is the
 * single source of truth shared between:
 *   - the per-card `<TorrentStateBadge>` (uses shortLabel + tone)
 *   - the deep `TorrentHealthPanel` modal (uses label + tone)
 *
 * The behaviours under test are deliberate UX choices that earlier user
 * feedback flagged as confusing if changed:
 *   - `stalledUP` is qBit's name for the resting state of healthy seeders.
 *     Surfacing it as "Stalled" misled operators (it sounds like a problem).
 *     We collapse `uploading`/`forcedUP`/`stalledUP` to `shortLabel: "Seeding"`
 *     and use `label: "Seeding (idle)"` only in the modal where there's room
 *     for the nuance. The badge stays terse.
 *   - `stalledDL` IS a real problem (download stuck) — keep it amber + distinct.
 *   - All other states preserve their qBit semantics.
 */

import { describe, expect, it } from "vitest";
import { describeQuiState } from "../qui-display";

describe("describeQuiState — short vs long label vocabulary", () => {
	it("collapses uploading + forcedUP + stalledUP into the short Seeding label", () => {
		// All three are healthy seeded states; the badge has no room for nuance.
		expect(describeQuiState("uploading").shortLabel).toBe("Seeding");
		expect(describeQuiState("forcedUP").shortLabel).toBe("Seeding");
		expect(describeQuiState("stalledUP").shortLabel).toBe("Seeding");
	});

	it("keeps the modal nuance for stalledUP (Seeding (idle))", () => {
		// In the modal the long label can distinguish stalledUP from uploading.
		// "Seeding (idle)" — not "Seeding (stalled)" — was the deliberate fix
		// for the user-reported confusion where operators read "stalled" as broken.
		expect(describeQuiState("uploading").label).toBe("Seeding");
		expect(describeQuiState("forcedUP").label).toBe("Seeding");
		expect(describeQuiState("stalledUP").label).toBe("Seeding (idle)");
	});

	it("uses emerald tone for ALL three seeding-equivalent states (visual unity)", () => {
		// The badge tone is what makes the three states look like one bucket
		// at a glance. Drift here would re-introduce the operator confusion.
		expect(describeQuiState("uploading").tone).toContain("emerald");
		expect(describeQuiState("forcedUP").tone).toContain("emerald");
		expect(describeQuiState("stalledUP").tone).toContain("emerald");
	});

	it("keeps stalledDL distinct (real problem, amber tone)", () => {
		const stalled = describeQuiState("stalledDL");
		expect(stalled.shortLabel).toBe("Stalled DL");
		expect(stalled.label).toBe("Downloading (stalled)");
		expect(stalled.tone).toContain("amber");
	});

	it("renders downloading + forcedDL + metaDL as Downloading (sky tone)", () => {
		for (const state of ["downloading", "forcedDL", "metaDL"]) {
			const d = describeQuiState(state);
			expect(d.label).toBe("Downloading");
			expect(d.shortLabel).toBe("Downloading");
			expect(d.tone).toContain("sky");
		}
	});

	it("renders error + missingFiles as Error (rose tone)", () => {
		for (const state of ["error", "missingFiles"]) {
			expect(describeQuiState(state).label).toBe("Error");
			expect(describeQuiState(state).tone).toContain("rose");
		}
	});

	it("falls back to Unknown for empty / unrecognised states (no throw)", () => {
		// Tolerates qBit adding states the project hasn't mapped yet — UI
		// degrades to a generic pill instead of crashing the modal.
		expect(describeQuiState("").label).toBe("Unknown");
		expect(describeQuiState("bogus").label).toBe("Unknown");
		expect(describeQuiState("brand-new-qbit-state").shortLabel).toBe("Unknown");
	});
});

describe("describeQuiState — bilingual (raw qBit + normalized) vocabulary", () => {
	// Phase 2.1 introduced normalized states (`seeding`/`stalled_dl`/etc.)
	// stored in `LibraryCache.torrentState`. The badge consumes those
	// directly. This test catches the regression where the function only
	// understood raw qBit states and would render normalized inputs as
	// "Unknown" — caught by the e2e walkthrough on 2026-05-06.

	it("recognises the normalized 'seeding' state from LibraryCache.torrentState", () => {
		const d = describeQuiState("seeding");
		expect(d.shortLabel).toBe("Seeding");
		expect(d.tone).toContain("emerald");
	});

	it("recognises 'stalled_dl' from the normalized vocabulary", () => {
		const d = describeQuiState("stalled_dl");
		expect(d.shortLabel).toBe("Stalled DL");
		expect(d.tone).toContain("amber");
	});

	it("recognises every normalized state from the @arr/shared schema", () => {
		// Mirror of the `normalizedTorrentStateSchema` enum — if this list
		// drifts from @arr/shared, the badge will silently fall back to
		// "Unknown" for the missing entry. Pin them all explicitly.
		const normalized = [
			"seeding",
			"downloading",
			"stalled_dl",
			"paused",
			"queued",
			"checking",
			"moving",
			"error",
			"unknown",
		] as const;
		for (const state of normalized) {
			const d = describeQuiState(state);
			// Every normalized state must yield a NON-Unknown descriptor (except
			// `unknown` itself — which IS the explicit "we don't know" label).
			if (state === "unknown") {
				expect(d.label).toBe("Unknown");
			} else {
				expect(d.label, `normalized state "${state}" should NOT fall through to Unknown`).not.toBe(
					"Unknown",
				);
			}
		}
	});
});
