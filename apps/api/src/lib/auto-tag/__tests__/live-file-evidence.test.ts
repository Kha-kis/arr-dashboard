import { describe, expect, it, vi } from "vitest";
import { evaluateSingleConditionState } from "../../library-cleanup/rule-evaluators.js";
import { adaptLiveArrItemForAutoTag } from "../live-arr-evidence.js";

const target = { instanceId: "synthetic-radarr", arrItemId: 100, itemType: "movie" as const };

describe("live Radarr file normalization at the actual evaluator", () => {
	it.each([
		{ videoCodec: "h265", audioCodec: "DTS", resolution: "3840x2160" },
		{ mediaInfo: { videoCodec: "h265", audioCodec: "DTS", width: 3840, height: 2160 } },
	])("retains flat and nested codec evidence", (metadata) => {
		const item = adaptLiveArrItemForAutoTag(
			{
				id: 100,
				title: "Synthetic movie",
				hasFile: true,
				movieFileId: 77,
				movieFile: { id: 77, ...metadata },
			},
			target,
		);
		expect(
			evaluateSingleConditionState(
				item,
				"video_codec",
				{ operator: "is", codecs: ["h265"] },
				{ now: new Date() },
			).state,
		).toBe("true");
	});
});

import { evaluateAutoTagConditionState, loadLiveArrItemForAutoTag } from "../live-file-evidence.js";
const codecRule = { ruleType: "video_codec" };
function fixture() {
	const full = {
		id: 100,
		title: "Synthetic movie",
		hasFile: true,
		movieFileId: 77,
		movieFile: { id: 77, mediaInfo: null },
	};
	const client = {
		movie: { getById: vi.fn(async (_id: number) => full) },
		movieFile: {
			getById: vi.fn(async (_id: number) => ({
				id: 77,
				movieId: 100,
				mediaInfo: { videoCodec: "h265" },
			})),
		},
	};
	const assertCurrent = vi.fn(async () => {});
	return {
		full,
		client,
		assertCurrent,
		load: () =>
			loadLiveArrItemForAutoTag({
				client: client as never,
				target,
				rules: [codecRule],
				assertCurrent,
			}),
	};
}
const codecState = (item: ReturnType<typeof adaptLiveArrItemForAutoTag>) =>
	evaluateSingleConditionState(
		item,
		"video_codec",
		{ operator: "is", codecs: ["h265"] },
		{ now: new Date() },
	).state;
describe("identity-bound live file loader", () => {
	it("hydrates only evaluation data, preserving raw null embedded media for PUT", async () => {
		const f = fixture();
		const result = await f.load();
		expect(codecState(result.item)).toBe("true");
		expect(result.fullItem).toBe(f.full);
		expect(f.full.movieFile.mediaInfo).toBeNull();
		expect(f.client.movie.getById).toHaveBeenCalledTimes(2);
		expect(f.client.movieFile.getById).toHaveBeenCalledWith(77);
	});
	it.each([{ videoCodec: "h265" }, { mediaInfo: { videoCodec: "h265" } }])(
		"uses complete identity-bound embedded metadata without another endpoint %j",
		async (metadata) => {
			const f = fixture();
			f.client.movie.getById.mockResolvedValue({
				...f.full,
				movieFile: { id: 77, ...metadata },
			} as never);
			expect(codecState((await f.load()).item)).toBe("true");
			expect(f.client.movieFile.getById).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ movieFileId: 0 },
		{ movieFileId: "77" },
		{ movieFileId: 78 },
		{ hasFile: false },
		{ movieFile: { id: -1, videoCodec: "h265" } },
		{ movieFile: { id: 77, movieId: 999, videoCodec: "h265" } },
		{ movieFileId: undefined, movieFile: { videoCodec: "h265" } },
	])("does not guess an inconsistent or absent file association %j", async (over) => {
		const f = fixture();
		f.client.movie.getById.mockResolvedValue({ ...f.full, ...over } as never);
		expect(codecState((await f.load()).item)).toBe("unknown");
		expect(f.client.movieFile.getById).not.toHaveBeenCalled();
	});
	it("rejects a mismatching movie before reading any file", async () => {
		const f = fixture();
		f.client.movie.getById.mockResolvedValue({ ...f.full, id: 999 });
		await expect(f.load()).rejects.toThrow("identity");
		expect(f.client.movieFile.getById).not.toHaveBeenCalled();
	});
	it("does not cross bound clients even when movie and file IDs collide", async () => {
		const a = fixture(),
			b = fixture();
		b.client.movieFile.getById.mockResolvedValue({
			id: 77,
			movieId: 999,
			mediaInfo: { videoCodec: "h265" },
		});
		expect(codecState((await a.load()).item)).toBe("true");
		expect(codecState((await b.load()).item)).toBe("unknown");
		expect(a.client.movieFile.getById).toHaveBeenCalledTimes(1);
		expect(b.client.movieFile.getById).toHaveBeenCalledTimes(1);
	});
});

describe("RG-01 retains partial current embedded evidence", () => {
	it.each(["unavailable", "sparse"] as const)(
		"keeps verified video with %s optional enrichment",
		async (mode) => {
			const f = fixture();
			f.client.movie.getById.mockResolvedValue({
				...f.full,
				movieFile: { id: 77, videoCodec: "h265" },
			} as never);
			if (mode === "unavailable")
				f.client.movieFile.getById.mockRejectedValue(new Error("synthetic unavailable"));
			else
				f.client.movieFile.getById.mockResolvedValue({
					id: 77,
					movieId: 100,
					mediaInfo: { audioCodec: "DTS" },
				} as never);
			const loaded = await loadLiveArrItemForAutoTag({
				client: f.client as never,
				target,
				rules: [{ ruleType: "video_codec" }, { ruleType: "audio_codec" }],
				assertCurrent: f.assertCurrent,
			});
			expect(codecState(loaded.item)).toBe("true");
			expect(
				evaluateSingleConditionState(
					loaded.item,
					"audio_codec",
					{ operator: "is", codecs: ["DTS"] },
					{ now: new Date() },
				).state,
			).toBe(mode === "sparse" ? "true" : "unknown");
		},
	);
	it("keeps contradicting verified fields unknown rather than selecting a conflicting value", async () => {
		const f = fixture();
		f.client.movie.getById.mockResolvedValue({
			...f.full,
			movieFile: { id: 77, videoCodec: "h265" },
		} as never);
		f.client.movieFile.getById.mockResolvedValue({
			id: 77,
			movieId: 100,
			mediaInfo: { videoCodec: "h264" },
		});
		const loaded = await loadLiveArrItemForAutoTag({
			client: f.client as never,
			target,
			rules: [{ ruleType: "video_codec" }, { ruleType: "audio_codec" }],
			assertCurrent: f.assertCurrent,
		});
		expect(codecState(loaded.item)).toBe("unknown");
	});
});

it("RG-D01 conflicting HDR stays unknown for none while an agreed codec stays true", async () => {
	const f = fixture();
	f.client.movie.getById.mockResolvedValue({
		...f.full,
		movieFile: { id: 77, videoCodec: "h265", videoDynamicRange: "HDR10" },
	} as never);
	f.client.movieFile.getById.mockResolvedValue({
		id: 77,
		movieId: 100,
		mediaInfo: { videoCodec: "h265", videoDynamicRange: "SDR" },
	} as never);
	const { item, fullItem } = await loadLiveArrItemForAutoTag({
		client: f.client as never,
		target,
		rules: [{ ruleType: "video_codec" }, { ruleType: "hdr_type" }, { ruleType: "release_group" }],
		assertCurrent: f.assertCurrent,
	});
	expect(
		evaluateAutoTagConditionState(item, "hdr_type", { operator: "none" }, { now: new Date() })
			.state,
	).toBe("unknown");
	expect(
		evaluateAutoTagConditionState(
			item,
			"video_codec",
			{ operator: "is", codecs: ["h265"] },
			{ now: new Date() },
		).state,
	).toBe("true");
	expect(fullItem.movieFile).toMatchObject({ videoDynamicRange: "HDR10" });
	expect(item.data).not.toContain("uncertainFileFields");
});
