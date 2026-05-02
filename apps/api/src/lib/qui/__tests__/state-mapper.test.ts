import { describe, expect, it } from "vitest";
import { classifyTorrentState, isActivelySeeding, isErrorState } from "../state-mapper.js";

describe("classifyTorrentState", () => {
	it("collapses all paused variants to 'paused'", () => {
		expect(classifyTorrentState("pausedUP")).toBe("paused");
		expect(classifyTorrentState("pausedDL")).toBe("paused");
	});

	it("collapses all queued variants to 'queued'", () => {
		expect(classifyTorrentState("queuedUP")).toBe("queued");
		expect(classifyTorrentState("queuedDL")).toBe("queued");
	});

	it("classifies seeding variants as 'seeding'", () => {
		expect(classifyTorrentState("uploading")).toBe("seeding");
		expect(classifyTorrentState("forcedUP")).toBe("seeding");
	});

	it("classifies downloading variants as 'downloading'", () => {
		expect(classifyTorrentState("downloading")).toBe("downloading");
		expect(classifyTorrentState("forcedDL")).toBe("downloading");
		expect(classifyTorrentState("metaDL")).toBe("downloading");
	});

	it("classifies missingFiles as 'error'", () => {
		expect(classifyTorrentState("missingFiles")).toBe("error");
		expect(classifyTorrentState("error")).toBe("error");
	});

	it("classifies stalled variants as 'stalled'", () => {
		expect(classifyTorrentState("stalledUP")).toBe("stalled");
		expect(classifyTorrentState("stalledDL")).toBe("stalled");
	});

	it("classifies checking variants as 'checking'", () => {
		expect(classifyTorrentState("checkingUP")).toBe("checking");
		expect(classifyTorrentState("checkingDL")).toBe("checking");
	});

	it("classifies moving as 'moving'", () => {
		expect(classifyTorrentState("moving")).toBe("moving");
	});

	it("classifies unknown as 'unknown'", () => {
		expect(classifyTorrentState("unknown")).toBe("unknown");
	});
});

describe("isActivelySeeding", () => {
	it("treats uploading and forcedUP as actively seeding", () => {
		expect(isActivelySeeding("uploading")).toBe(true);
		expect(isActivelySeeding("forcedUP")).toBe(true);
	});

	it("treats stalledUP as actively seeding (peers may return)", () => {
		// stalledUP means the torrent is seeding but no peers are connected.
		// The Library Cleanup gate must NOT treat this as deletable — peers
		// often re-appear within hours.
		expect(isActivelySeeding("stalledUP")).toBe(true);
	});

	it("does not treat stalledDL as actively seeding", () => {
		expect(isActivelySeeding("stalledDL")).toBe(false);
	});

	it("does not treat paused or error states as actively seeding", () => {
		expect(isActivelySeeding("pausedUP")).toBe(false);
		expect(isActivelySeeding("pausedDL")).toBe(false);
		expect(isActivelySeeding("error")).toBe(false);
		expect(isActivelySeeding("missingFiles")).toBe(false);
	});

	it("does not treat downloading as actively seeding", () => {
		expect(isActivelySeeding("downloading")).toBe(false);
	});
});

describe("isErrorState", () => {
	it("flags error and missingFiles", () => {
		expect(isErrorState("error")).toBe(true);
		expect(isErrorState("missingFiles")).toBe(true);
	});

	it("does not flag normal states", () => {
		expect(isErrorState("downloading")).toBe(false);
		expect(isErrorState("uploading")).toBe(false);
		expect(isErrorState("pausedUP")).toBe(false);
	});
});
