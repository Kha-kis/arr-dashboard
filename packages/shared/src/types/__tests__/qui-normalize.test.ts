import { describe, expect, it } from "vitest";
import { normalizeTorrentState } from "../qui";

describe("normalizeTorrentState", () => {
	it("collapses uploading + stalledUP + forcedUP into 'seeding'", () => {
		// stalledUP is the resting state of healthy seeders — surfacing it as
		// 'stalled' historically misled operators. The normalizer collapses
		// these three into one user-facing concept; the deep modal still
		// uses (idle) nuance to distinguish stalledUP via qui-display.ts.
		expect(normalizeTorrentState("uploading")).toBe("seeding");
		expect(normalizeTorrentState("forcedUP")).toBe("seeding");
		expect(normalizeTorrentState("stalledUP")).toBe("seeding");
	});

	it("keeps stalledDL distinct because it IS a real problem", () => {
		expect(normalizeTorrentState("stalledDL")).toBe("stalled_dl");
	});

	it("groups downloading variants into 'downloading'", () => {
		expect(normalizeTorrentState("downloading")).toBe("downloading");
		expect(normalizeTorrentState("forcedDL")).toBe("downloading");
		expect(normalizeTorrentState("metaDL")).toBe("downloading");
	});

	it("groups paused, queued, checking variants by direction-agnostic concept", () => {
		expect(normalizeTorrentState("pausedUP")).toBe("paused");
		expect(normalizeTorrentState("pausedDL")).toBe("paused");
		expect(normalizeTorrentState("queuedUP")).toBe("queued");
		expect(normalizeTorrentState("queuedDL")).toBe("queued");
		expect(normalizeTorrentState("checkingUP")).toBe("checking");
		expect(normalizeTorrentState("checkingDL")).toBe("checking");
	});

	it("collapses error + missingFiles into 'error' (both unactionable)", () => {
		expect(normalizeTorrentState("error")).toBe("error");
		expect(normalizeTorrentState("missingFiles")).toBe("error");
	});

	it("preserves 'moving' as its own state (not error, not paused)", () => {
		expect(normalizeTorrentState("moving")).toBe("moving");
	});

	it("falls back to 'unknown' for null, undefined, empty, or unrecognised states", () => {
		// `null`/`undefined` come from cache rows that never received a sync.
		// Unrecognised strings come from new qBit states the project hasn't
		// mapped yet — the schema does not have to evolve to tolerate them.
		expect(normalizeTorrentState(null)).toBe("unknown");
		expect(normalizeTorrentState(undefined)).toBe("unknown");
		expect(normalizeTorrentState("")).toBe("unknown");
		expect(normalizeTorrentState("bogusState")).toBe("unknown");
	});
});
