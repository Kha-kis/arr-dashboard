import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../auth-session-signal";
import { ApiError, UnauthorizedError } from "./base";
import { notificationsApi } from "./notifications";

const path = "/api/notifications/channel-types";
const privateMarker = "synthetic-private-catalog-detail";
const field = { key: "url", label: "Endpoint", type: "url", required: true };
const descriptor = { type: "WEBHOOK", label: "Webhook", icon: "Globe", formFields: [field] };

function response(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function serve(value: Response) {
	const fetch = vi.fn().mockResolvedValue(value);
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => {
	vi.unstubAllGlobals();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
});

describe("notification catalog response admission", () => {
	// Guards coercion/stripping and static-enum restrictions: valid extension and
	// dynamic descriptors still reach consumers intact, including optional false.
	it("preserves valid descriptors, all supported kinds and benign extensions on one GET", async () => {
		const value = [
			{
				...descriptor,
				extension: { future: true },
				formFields: [
					{ ...field, placeholder: "https://synthetic.invalid", required: true },
					{ key: "method", label: "Method", type: "text" },
					{ key: "recipient", label: "Recipient", type: "email" },
					{ key: "secret", label: "Secret", type: "password", placeholder: "", required: false },
					{ key: "port", label: "Port", type: "number", extension: "future" },
					{ key: "secure", label: "Secure", type: "boolean" },
					{ key: "headers", label: "Headers", type: "headers" },
				],
			},
			{ type: "BROWSER_PUSH", label: "BROWSER PUSH", icon: "Bell", formFields: [] },
			{ type: "FUTURE_PLUGIN", label: "Future", icon: "Bell", formFields: [] },
		];
		const fetch = serve(response(value));
		expect(await notificationsApi.getChannelTypes()).toEqual(value);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith(
			path,
			expect.objectContaining({ method: "GET", credentials: "include", body: undefined }),
		);
	});

	it("preserves a valid empty catalog rather than inventing definitions", async () => {
		serve(response([]));
		expect(await notificationsApi.getChannelTypes()).toEqual([]);
	});

	// Removing whole-catalog admission lets malformed rows succeed (or silently
	// drops one), and poisons the real query consumer; no helper under test builds
	// the expected rejection.
	it.each([
		["null catalog", null],
		["object catalog", { ...descriptor, detail: privateMarker }],
		["string catalog", privateMarker],
		["number catalog", 7],
		["boolean catalog", false],
		["null descriptor", [descriptor, null]],
		["array descriptor", [descriptor, []]],
		["primitive descriptor", [descriptor, privateMarker]],
		["missing type", [{ label: "Webhook", icon: "Globe", formFields: [] }]],
		["nonstring type", [{ ...descriptor, type: 7 }]],
		["blank type", [{ ...descriptor, type: " \t" }]],
		["missing label", [{ type: "WEBHOOK", icon: "Globe", formFields: [] }]],
		["blank label", [{ ...descriptor, label: " " }]],
		["nonstring label", [{ ...descriptor, label: false }]],
		["missing icon", [{ type: "WEBHOOK", label: "Webhook", formFields: [] }]],
		["blank icon", [{ ...descriptor, icon: "\n" }]],
		["nonstring icon", [{ ...descriptor, icon: {} }]],
		["missing fields", [{ type: "WEBHOOK", label: "Webhook", icon: "Globe" }]],
		["null fields", [{ ...descriptor, formFields: null }]],
		["string fields", [{ ...descriptor, formFields: privateMarker }]],
		["object fields", [{ ...descriptor, formFields: field }]],
		["null field", [{ ...descriptor, formFields: [null] }]],
		["array field", [{ ...descriptor, formFields: [[]] }]],
		["primitive field", [{ ...descriptor, formFields: [privateMarker] }]],
		["missing field key", [{ ...descriptor, formFields: [{ label: "URL", type: "url" }] }]],
		["blank field key", [{ ...descriptor, formFields: [{ ...field, key: " " }] }]],
		["nonstring field key", [{ ...descriptor, formFields: [{ ...field, key: 7 }] }]],
		["missing field label", [{ ...descriptor, formFields: [{ key: "url", type: "url" }] }]],
		["blank field label", [{ ...descriptor, formFields: [{ ...field, label: " " }] }]],
		["nonstring field label", [{ ...descriptor, formFields: [{ ...field, label: {} }] }]],
		["missing field kind", [{ ...descriptor, formFields: [{ key: "url", label: "URL" }] }]],
		["unsupported field kind", [{ ...descriptor, formFields: [{ ...field, type: "select" }] }]],
		["nonstring field kind", [{ ...descriptor, formFields: [{ ...field, type: 7 }] }]],
		["coerced required", [{ ...descriptor, formFields: [{ ...field, required: "true" }] }]],
		["null required", [{ ...descriptor, formFields: [{ ...field, required: null }] }]],
		["coerced placeholder", [{ ...descriptor, formFields: [{ ...field, placeholder: 7 }] }]],
		["null placeholder", [{ ...descriptor, formFields: [{ ...field, placeholder: null }] }]],
		["duplicate type", [descriptor, { ...descriptor, formFields: [] }]],
		[
			"duplicate field key",
			[{ ...descriptor, formFields: [field, { ...field, type: "password" }] }],
		],
	])("rejects %s as a whole with a generic error", async (_name, value) => {
		const fetch = serve(response(value));
		await expect(notificationsApi.getChannelTypes()).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error &&
				/channel.*definitions.*could not be loaded/i.test(error.message) &&
				!String(error).includes(privateMarker) &&
				!("payload" in error),
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([
		["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
		["non-JSON success", () => new Response(privateMarker)],
		["204 without catalog", () => new Response(null, { status: 204 })],
	])("does not certify %s", async (_name, makeResponse) => {
		serve(makeResponse());
		await expect(notificationsApi.getChannelTypes()).rejects.toThrow(/channel.*definitions/i);
	});

	it("keeps 401 as unauthorized, not malformed-catalog success or failure", async () => {
		serve(response({ message: privateMarker }, 401));
		await expect(notificationsApi.getChannelTypes()).rejects.toBeInstanceOf(UnauthorizedError);
	});

	it("preserves non-auth HTTP failure status instead of certifying an empty catalog", async () => {
		serve(response({ error: privateMarker }, 503));
		await expect(notificationsApi.getChannelTypes()).rejects.toSatisfy(
			(error: unknown) => error instanceof ApiError && error.status === 503,
		);
	});
});
