/**
 * Tests for the incognito-mode string masking helpers.
 *
 * Scope intentionally narrow: pins the trust-quality invariants that the
 * v2.16 Needs Attention trust-check surfaced. In particular:
 *
 *   1. `anonymizePulseText` must NOT treat system-sourced pulse titles
 *      (scheduler jobs, cache health) as ARR-instance titles, because the
 *      " is " / ": " split would map system job names to Linux-hostname
 *      placeholders and actively mislead the reader.
 *   2. `anonymizeHealthMessage` must strip embedded URLs and IPv4 addresses,
 *      because scheduler `lastError` strings and generic upstream errors
 *      routinely carry instance URLs that the narrower pre-v2.16 patterns
 *      didn't catch.
 */

import { describe, expect, it } from "vitest";
import {
	anonymizeHealthMessage,
	anonymizePulseItemContent,
	anonymizePulseText,
} from "../incognito";

describe("anonymizePulseText — source-aware masking", () => {
	it("leaves system-sourced titles un-split (no instance-label substitution)", () => {
		// Before source-awareness, `"Library Sync is disabled"` would split on
		// " is " and map `"Library Sync"` → e.g. `"ubuntu-42"` via
		// getLinuxInstanceName, turning a scheduler job into what looks like
		// an ARR instance. The fix: when `source === "system"`, run the whole
		// string through anonymizeHealthMessage without splitting.
		const out = anonymizePulseText("Library Sync is disabled", "system");
		expect(out).toBe("Library Sync is disabled");
	});

	it("still anonymizes instance-sourced ': ' titles", () => {
		// Instance items keep the existing behavior — label stripped, message
		// sanitized.
		const out = anonymizePulseText("Sonarr Prod: Indexer X failed");
		expect(out).not.toContain("Sonarr Prod");
		expect(out).toContain(":");
	});

	it("still anonymizes instance-sourced ' is ' titles", () => {
		const out = anonymizePulseText("Sonarr Prod is unreachable");
		expect(out).not.toContain("Sonarr Prod");
		expect(out).toMatch(/ is unreachable$/);
	});

	it("runs system-sourced titles through anonymizeHealthMessage (URLs stripped)", () => {
		// System items still get their embedded URLs masked — the
		// source === "system" branch delegates to anonymizeHealthMessage.
		const out = anonymizePulseText(
			"Backup failed contacting http://sonarr.local:8989/api",
			"system",
		);
		expect(out).not.toContain("sonarr.local");
		expect(out).toContain("linux-host");
	});

	it("masks BOTH the qui label and the qBit instance name in qui-sourced titles", () => {
		// qui's federation introduces a dual-name title shape that the
		// general single-name branch can't fully anonymize. Without the
		// qui-specific branch, `qbit-main` would leak through.
		const out = anonymizePulseText("Home Qbit: qbit-main is disconnected", "qui");
		expect(out).not.toContain("Home Qbit");
		expect(out).not.toContain("qbit-main");
		expect(out).toMatch(/ is disconnected$/);
	});

	it("masks the qui label alone in single-name qui titles (no colon)", () => {
		// "<label> is unreachable" — only one name to hide; falls through to
		// the general single-name branch.
		const out = anonymizePulseText("Home Qbit is unreachable", "qui");
		expect(out).not.toContain("Home Qbit");
		expect(out).toMatch(/ is unreachable$/);
	});
});

describe("anonymizeHealthMessage — URL and IP stripping", () => {
	it("strips absolute http(s) URLs", () => {
		const out = anonymizeHealthMessage("Timed out calling http://sonarr.local:8989/api/v3/health");
		expect(out).not.toContain("sonarr.local");
		expect(out).not.toContain(":8989");
		expect(out).toContain("http://linux-host");
	});

	it("strips https URLs as well", () => {
		const out = anonymizeHealthMessage("GET https://prowlarr.example.net/api/v1/indexer failed");
		expect(out).not.toContain("prowlarr.example.net");
		expect(out).toContain("http://linux-host");
	});

	it("strips bare IPv4 addresses and ip:port pairs", () => {
		const out = anonymizeHealthMessage("Connection refused to 192.168.1.42:7878");
		expect(out).not.toContain("192.168.1.42");
		expect(out).toContain("10.0.0.1");
	});

	it("preserves the known Prowlarr indexer substitution alongside URL stripping", () => {
		// Regression guard: the URL pass runs before the indexer pass, so
		// adding URL stripping must not break the older substitutions.
		const out = anonymizeHealthMessage(
			"MyIndexer (Prowlarr) unreachable at http://proxy.local:9696",
		);
		expect(out).toContain("LinuxTracker");
		expect(out).toContain("http://linux-host");
		expect(out).not.toContain("MyIndexer");
		expect(out).not.toContain("proxy.local");
	});
});

describe("anonymizePulseItemContent — *arr queue rows mask release titles", () => {
	// The leak this pins (found 2026-06-11 during the Operator Console
	// live-verify): queue-failure rows embed a bare media release title,
	// which none of the health-message patterns catch. Shape comes from
	// collectArrQueueFailures: title `"Label: Release (failed|warning)"`,
	// stable id `queue-failed-*` / `queue-stuck-*`, detail = *arr error
	// message that often embeds the same release name.

	it("masks the release title in a queue-failed row, preserving the state suffix", () => {
		const { title } = anonymizePulseItemContent({
			id: "queue-failed-inst1-42",
			source: "lidarr",
			title: "Primary Lidarr: Jimmy Eat World - 2001 - Bleed American [2008 Remaster] (failed)",
		});
		expect(title).not.toContain("Jimmy Eat World");
		expect(title).not.toContain("Bleed American");
		expect(title).not.toContain("Primary Lidarr");
		expect(title).toMatch(/ \(failed\)$/);
	});

	it("masks queue-stuck rows with the (warning) suffix", () => {
		const { title } = anonymizePulseItemContent({
			id: "queue-stuck-inst1-7",
			source: "sonarr",
			title: "Sonarr Prod: Some.Show.S01E01.1080p.WEB-GROUP (warning)",
		});
		expect(title).not.toContain("Some.Show");
		expect(title).toMatch(/ \(warning\)$/);
	});

	it("excises the release name embedded in the detail (error message)", () => {
		const { detail } = anonymizePulseItemContent({
			id: "queue-failed-inst1-42",
			source: "lidarr",
			title: "Primary Lidarr: Jimmy Eat World - Bleed American (failed)",
			detail:
				"No files eligible for import in Jimmy Eat World - Bleed American, manual import required",
		});
		expect(detail).not.toContain("Jimmy Eat World");
		expect(detail).not.toContain("Bleed American");
		expect(detail).toContain("manual import required");
	});

	it("excises the FULL name from detail when the row title was server-truncated", () => {
		// collectors.ts shortens long titles with a trailing "…"; the detail
		// keeps the full name. Excision must match from the prefix onward.
		const { detail } = anonymizePulseItemContent({
			id: "queue-failed-inst1-42",
			source: "lidarr",
			title: "Primary Lidarr: Jimmy Eat World - 2001 - Bleed Ameri… (failed)",
			detail:
				"Stalled in queue: Jimmy Eat World - 2001 - Bleed American [2008 Remastered Deluxe Edition]",
		});
		expect(detail).not.toContain("Jimmy Eat World");
		expect(detail).not.toContain("Remastered Deluxe");
		expect(detail).toContain("Stalled in queue:");
	});

	it("handles regex-special characters in release titles without throwing", () => {
		const { title, detail } = anonymizePulseItemContent({
			id: "queue-failed-inst1-9",
			source: "radarr",
			title: "Radarr 4K: Movie (2024) [Remux-2160p] {Edition} (failed)",
			detail: "Download Movie (2024) [Remux-2160p] {Edition} failed",
		});
		expect(title).not.toContain("Remux-2160p");
		expect(detail).not.toContain("Remux-2160p");
	});

	it("delegates non-queue rows to the existing source-aware behavior", () => {
		const system = anonymizePulseItemContent({
			id: "scheduler-disabled-hunting",
			source: "system",
			title: "Library Sync is disabled",
			detail: "Enable it in settings",
		});
		expect(system.title).toBe("Library Sync is disabled");
		expect(system.detail).toBe("Enable it in settings");

		const instance = anonymizePulseItemContent({
			id: "arr-health-inst1",
			source: "sonarr",
			title: "Sonarr Prod: Indexer X failed",
		});
		expect(instance.title).not.toContain("Sonarr Prod");
	});

	it("leaves detail undefined when the item has none", () => {
		const { detail } = anonymizePulseItemContent({
			id: "queue-failed-inst1-1",
			source: "sonarr",
			title: "Sonarr Prod: Show Name (failed)",
		});
		expect(detail).toBeUndefined();
	});
});
