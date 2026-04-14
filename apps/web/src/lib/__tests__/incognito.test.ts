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
import { anonymizeHealthMessage, anonymizePulseText } from "../incognito";

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
});

describe("anonymizeHealthMessage — URL and IP stripping", () => {
	it("strips absolute http(s) URLs", () => {
		const out = anonymizeHealthMessage(
			"Timed out calling http://sonarr.local:8989/api/v3/health",
		);
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
