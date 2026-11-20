import { describe, expect, it } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { projectQuiTrackerViews, resolveQuiTrackerSelection } from "../tracker-selection.js";

const BASE_SCOPE = {
	userId: "user-1",
	serviceInstanceId: "qui-1",
	qbitInstanceId: 7,
	hash: "A".repeat(40),
};
const createEncryptor = (key = "x".repeat(32)) => new Encryptor(key);

const row = (url: string, tier = 0) => ({
	url,
	status: 2,
	health: "working" as const,
	msg: "private provider message",
	numSeeds: 3,
	numLeeches: 1,
	numPeers: 4,
	tier,
});

describe("qUI tracker selector projection", () => {
	it("keeps selectors stable when tracker rows reorder", () => {
		const encryptor = createEncryptor();
		const trackers = [
			row("https://one.example/announce?passkey=private-one"),
			row("https://two.example/a"),
		];
		const first = projectQuiTrackerViews(encryptor, BASE_SCOPE, trackers);
		const reordered = projectQuiTrackerViews(encryptor, BASE_SCOPE, [...trackers].reverse());
		expect(
			new Map(first.map((item) => [item.hostname, item.trackerSelector])).get("one.example"),
		).toBe(
			new Map(reordered.map((item) => [item.hostname, item.trackerSelector])).get("one.example"),
		);
		expect(JSON.stringify(first)).not.toContain("private-one");
		expect(JSON.stringify(first)).not.toContain("private provider message");
	});

	it("binds selectors to owner, connection, qBit instance, hash, URL and encryption key", () => {
		const encryptor = createEncryptor();
		const tracker = row("https://one.example/announce?passkey=private");
		const original = projectQuiTrackerViews(encryptor, BASE_SCOPE, [tracker])[0]?.trackerSelector;
		const scopes = [
			{ ...BASE_SCOPE, userId: "user-2" },
			{ ...BASE_SCOPE, serviceInstanceId: "qui-2" },
			{ ...BASE_SCOPE, qbitInstanceId: 8 },
			{ ...BASE_SCOPE, hash: "b".repeat(40) },
		];
		for (const scope of scopes) {
			expect(projectQuiTrackerViews(encryptor, scope, [tracker])[0]?.trackerSelector).not.toBe(
				original,
			);
		}
		expect(
			projectQuiTrackerViews(encryptor, BASE_SCOPE, [
				row("https://one.example/other?passkey=private"),
			])[0]?.trackerSelector,
		).not.toBe(original);
		expect(
			projectQuiTrackerViews(createEncryptor("y".repeat(32)), BASE_SCOPE, [tracker])[0]
				?.trackerSelector,
		).not.toBe(original);
	});

	it("rejects tampered and stale selectors instead of resolving a subset", () => {
		const encryptor = createEncryptor();
		const tracker = row("https://one.example/announce?passkey=private");
		const selector = projectQuiTrackerViews(encryptor, BASE_SCOPE, [tracker])[0]!.trackerSelector!;
		expect(() =>
			resolveQuiTrackerSelection(encryptor, BASE_SCOPE, [tracker], {
				trackerSelectors: [`${selector.slice(0, 63)}0`],
			}),
		).toThrow();
		expect(() =>
			resolveQuiTrackerSelection(encryptor, BASE_SCOPE, [row("https://one.example/changed")], {
				trackerSelectors: [selector],
			}),
		).toThrow();
	});

	it("omits pseudo rows and keeps malformed real rows visible but unavailable", () => {
		const encryptor = createEncryptor();
		const views = projectQuiTrackerViews(encryptor, BASE_SCOPE, [
			row("** [DHT] **"),
			row("not a url"),
		]);
		expect(views).toHaveLength(1);
		expect(views[0]?.hostname).toBe("Tracker unavailable");
		expect(views[0]?.selectable).toBe(false);
		expect(JSON.stringify(views)).not.toContain("not a url");
	});

	it("marks duplicate full URLs and indistinguishable safe labels nonselectable", () => {
		const encryptor = createEncryptor();
		const duplicateUrl = "https://same.example/announce?passkey=private";
		const exactDuplicates = projectQuiTrackerViews(encryptor, BASE_SCOPE, [
			row(duplicateUrl),
			row(duplicateUrl),
		]);
		expect(exactDuplicates.every((item) => item.trackerSelector === null && !item.selectable)).toBe(
			true,
		);
		const sameLabel = projectQuiTrackerViews(encryptor, BASE_SCOPE, [
			row("https://same.example/one", 0),
			row("https://same.example/two", 0),
		]);
		expect(sameLabel.every((item) => !item.selectable)).toBe(true);
		expect(sameLabel[0]?.trackerSelector).not.toBe(sameLabel[1]?.trackerSelector);
	});

	it("requires each legacy hostname to resolve exactly once", () => {
		const encryptor = createEncryptor();
		const trackers = [row("https://one.example/announce"), row("https://two.example/announce")];
		expect(() =>
			resolveQuiTrackerSelection(encryptor, BASE_SCOPE, trackers, {
				hostnames: ["one.example", "missing.example"],
			}),
		).toThrow();
		expect(() =>
			resolveQuiTrackerSelection(
				encryptor,
				BASE_SCOPE,
				[row("https://duplicate.example/one"), row("https://duplicate.example/two")],
				{ hostnames: ["duplicate.example"] },
			),
		).toThrow();
	});
});
