import { describe, expect, it } from "vitest";
import { getPortConfig, getSecurityConfig, parseBooleanEnv } from "./port-config.js";

describe("explicit startup settings resolution", () => {
	const settings = { apiPort: 4111, webPort: 5111, trustProxy: true, secureCookies: false };
	it("resolves supplied database ports without opening or caching another database", () => {
		expect(getPortConfig(settings, {})).toEqual({
			apiPort: 4111,
			webPort: 5111,
			source: { apiPort: "database", webPort: "database" },
		});
		expect(getPortConfig({ ...settings, apiPort: 4222 }, {})).toEqual({
			apiPort: 4222,
			webPort: 5111,
			source: { apiPort: "database", webPort: "database" },
		});
	});
	it("environment ports override only the fields explicitly set, including port zero", () => {
		expect(getPortConfig(settings, { API_PORT: "0" })).toEqual({
			apiPort: 0,
			webPort: 5111,
			source: { apiPort: "env", webPort: "database" },
		});
		expect(getPortConfig(settings, { API_PORT: "4333", PORT: "5333" })).toEqual({
			apiPort: 4333,
			webPort: 5333,
			source: { apiPort: "env", webPort: "env" },
		});
	});
	it("absent database and environment ports retain the established defaults", () => {
		expect(getPortConfig(null, {})).toEqual({
			apiPort: 3001,
			webPort: 3000,
			source: { apiPort: "default", webPort: "default" },
		});
	});
	it.each([true, 1])("native provider boolean %s preserves database security settings", (value) => {
		expect(getSecurityConfig({ ...settings, trustProxy: value }, {})).toEqual({
			trustProxy: true,
			secureCookies: false,
			source: { trustProxy: "database", secureCookies: "database" },
		});
	});
	it("explicit environment false overrides database true without changing auto-cookie defaults", () => {
		expect(
			getSecurityConfig(
				{ ...settings, secureCookies: true },
				{ TRUST_PROXY: "false", COOKIE_SECURE: "0" },
			),
		).toEqual({
			trustProxy: false,
			secureCookies: false,
			source: { trustProxy: "env", secureCookies: "env" },
		});
		expect(getSecurityConfig(null, {})).toEqual({
			trustProxy: false,
			secureCookies: undefined,
			source: { trustProxy: "default", secureCookies: "default" },
		});
	});
	it.each(["true", "TRUE", "1", "yes"])(
		"existing truthy environment value %s stays compatible",
		(value) => {
			expect(parseBooleanEnv(value)).toBe(true);
		},
	);
});
