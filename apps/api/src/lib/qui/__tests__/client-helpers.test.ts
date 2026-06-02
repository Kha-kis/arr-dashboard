import { describe, expect, it } from "vitest";
import { extractHostnameSafe } from "../client-helpers.js";

describe("extractHostnameSafe", () => {
	it("keeps a bare https announce hostname", () => {
		expect(extractHostnameSafe("https://tracker.example.com/announce")).toBe("tracker.example.com");
	});

	it("strips a passkey embedded in the path", () => {
		expect(extractHostnameSafe("https://tracker.beyond-hd.me:2053/announce/SECRETPASSKEY")).toBe(
			"tracker.beyond-hd.me",
		);
	});

	it("strips a passkey embedded in the query string", () => {
		expect(extractHostnameSafe("https://hdbits.org/announce.php?passkey=SECRETPASSKEY")).toBe(
			"hdbits.org",
		);
	});

	it("strips userinfo so credentials never leak via the host", () => {
		expect(extractHostnameSafe("http://user:pass@tracker.example.com/announce")).toBe(
			"tracker.example.com",
		);
	});

	it("handles non-http announce schemes (udp)", () => {
		expect(extractHostnameSafe("udp://tracker.opentrackr.org:1337/announce")).toBe(
			"tracker.opentrackr.org",
		);
	});

	it("returns empty string for empty input", () => {
		expect(extractHostnameSafe("")).toBe("");
	});

	it("returns empty string for an unparseable value rather than risking a leak", () => {
		expect(extractHostnameSafe("not a url /announce/SECRETPASSKEY")).toBe("");
	});
});
