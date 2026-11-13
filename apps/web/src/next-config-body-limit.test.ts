import { RESTORE_UPLOAD_BODY_LIMIT } from "@arr/shared";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("web proxy Restore transport contract", () => {
	it("loads the supported wire ceiling without changing API or auth rewrites", () => {
		// Execute the same ESM config that Next loads, including the built shared
		// package. This catches missing build exports as well as buffer regressions.
		const configUrl = pathToFileURL(resolve(import.meta.dirname, "../next.config.mjs")).href;
		const config = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import config from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({bodyLimit:config.experimental?.proxyClientMaxBodySize,rewrites:await config.rewrites()}));`,
				],
				{
					env: {
						PATH: process.env.PATH,
						NODE_ENV: "production",
						API_HOST: "http://127.0.0.1:3001",
					},
					encoding: "utf8",
					timeout: 10_000,
				},
			),
		);
		expect(config.bodyLimit).toBe(RESTORE_UPLOAD_BODY_LIMIT);
		expect(config.rewrites).toEqual([
			{ source: "/api/:path*", destination: "http://127.0.0.1:3001/api/:path*" },
			{ source: "/auth/:path*", destination: "http://127.0.0.1:3001/auth/:path*" },
		]);
	});
});
