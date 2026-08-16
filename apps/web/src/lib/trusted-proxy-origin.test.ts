import { describe, expect, it } from "vitest";
import { buildTrustedProxyHeaders } from "./trusted-proxy-origin";

describe("buildTrustedProxyHeaders", () => {
	it("replaces client-supplied proxy metadata with the Next request origin", () => {
		const headers = buildTrustedProxyHeaders({
			headers: new Headers({
				host: "backend.internal:3000",
				"x-arr-dashboard-origin": "https://attacker.example",
				"x-forwarded-host": "attacker.example, arr.example.com",
				"x-forwarded-proto": "http, https",
			}),
			nextUrl: new URL("http://0.0.0.0:3000/auth/oidc/setup"),
		} as never);

		expect(headers.get("x-arr-dashboard-origin")).toBe("https://arr.example.com");
		expect(headers.get("x-forwarded-host")).toBe("arr.example.com");
		expect(headers.get("x-forwarded-proto")).toBe("https");
	});

	it("falls back to Host and the request protocol without forwarded metadata", () => {
		const headers = buildTrustedProxyHeaders({
			headers: new Headers({ host: "arr.example.com" }),
			nextUrl: new URL("http://0.0.0.0:3000/auth/oidc/setup"),
		} as never);

		expect(headers.get("x-arr-dashboard-origin")).toBe("http://arr.example.com");
		expect(headers.get("x-forwarded-host")).toBe("arr.example.com");
		expect(headers.get("x-forwarded-proto")).toBe("http");
	});
});
