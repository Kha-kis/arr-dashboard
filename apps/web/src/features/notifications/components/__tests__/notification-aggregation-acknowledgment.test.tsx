import type { AggregationConfigResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AggregationConfig } from "../aggregation-config";

const path = "/api/notifications/aggregation";
const privateDetail = "synthetic-private-aggregation-ack-detail";
// Complete public DTOs, independently derived; no production parser or builder
// computes the expected cache or transport payload.
const baseline: AggregationConfigResponse[] = [
	{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: true },
	{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
];
const editedCache: AggregationConfigResponse[] = [
	{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 600, maxBatchSize: 10, enabled: true },
	{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
];
const editedPayload = {
	configs: [
		{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 600, maxBatchSize: 10, enabled: true },
	],
};

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const violations: string[] = [];

// Only external fetch is replaced. All mounted providers, editor state, query
// lifecycle, mutation callbacks, response parsing and serialization are real.
function fixture(
	reply: (attempt: number) => Response | Promise<Response>,
	options: { read?: "pending" | "failed"; mutationRetry?: boolean } = {},
) {
	const writes: Array<{ path: string; method: string; payload: unknown }> = [];
	const reads: string[] = [];
	let reviewRead: "baseline" | "failed" | "pending" = options.read ?? "pending";
	let reviewBody: unknown = baseline;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const requestPath = String(input);
		const method = init.method ?? "GET";
		if (requestPath === path && method === "PUT") {
			writes.push({ path: requestPath, method, payload: JSON.parse(String(init.body)) });
			return reply(writes.length);
		}
		if (requestPath === path && method === "GET") {
			reads.push(requestPath);
			if (reviewRead === "baseline") return json(reviewBody);
			if (reviewRead === "failed") return json({ message: privateDetail }, 503);
			return new Promise<Response>((resolve) => releases.push(() => resolve(json(baseline))));
		}
		violations.push(`${method} ${requestPath}`);
		throw new Error("Out-of-scope synthetic request");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				staleTime: 30_000,
				gcTime: 300_000,
				retry: 1,
				retryDelay: 0,
				structuralSharing: true,
			},
			// Production RootProviders does not override mutation retries. This
			// opt-in is separately named, never evidence of production auto-replay.
			...(options.mutationRetry && { mutations: { retry: 1, retryDelay: 0 } }),
		},
	});
	clients.push(client);
	client.setQueryData(notificationKeys.aggregation, baseline);
	const view = mountEditor(client);
	return {
		client,
		writes,
		reads,
		view,
		reviewReads(next: "baseline" | "failed", body: unknown = baseline) {
			reviewRead = next;
			reviewBody = body;
		},
	};
}

function mountEditor(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<AggregationConfig />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

function windowInput() {
	return screen.getByRole("combobox", { name: "Hunt: Content Found aggregation window" });
}
function saveButton() {
	return screen.queryByRole("button", { name: "Save Changes" });
}
function editWindow() {
	fireEvent.change(windowInput(), { target: { value: "600" } });
}
function save() {
	fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}
function cached(client: QueryClient) {
	return client.getQueryData<AggregationConfigResponse[]>(notificationKeys.aggregation);
}
async function settled(client: QueryClient, count = 1) {
	await waitFor(() => {
		const mutations = client.getMutationCache().getAll();
		expect(mutations).toHaveLength(count);
		for (const mutation of mutations) {
			expect(["success", "error"]).toContain(mutation.state.status);
		}
	});
	// Let actual mutation-observer notifications publish into the editor.
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
function expectRetainedDraft(client: QueryClient) {
	expect.soft(saveButton()).toBeInTheDocument();
	expect.soft(windowInput()).toHaveValue("600");
	expect.soft(cached(client)).toEqual(baseline);
}
function expectUnknownGuidance() {
	// Meaning only: no prescribed new message, error class, or internal design.
	expect
		.soft(document.body)
		.toHaveTextContent(/unverified|not.*verified|may.*saved|may.*completed/i);
	expect.soft(document.body).toHaveTextContent(/review|recheck|reload/i);
	expect.soft(document.body).not.toHaveTextContent(/retry Save Changes/i);
	expect.soft(document.body).not.toHaveTextContent(privateDetail);
}
function expectSanitizedUnknown(error: unknown) {
	expect.soft(error).toBeInstanceOf(Error);
	if (error instanceof Error) {
		expect.soft(error.message).toMatch(/acknowledg|verif|outcome|uncertain/i);
		expect.soft(error.message).not.toContain(privateDetail);
		expect.soft(error.cause).toBeUndefined();
		expect.soft(JSON.stringify(error)).not.toContain(privateDetail);
		expect.soft(error).not.toHaveProperty("payload");
		expect.soft(error).not.toHaveProperty("response");
	}
}
function reviewButton() {
	return screen.queryByRole("button", { name: /review|recheck|reload.*aggregation/i });
}

afterEach(async () => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	await act(async () => {
		for (const release of releases.splice(0)) release();
	});
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});

describe("Aggregation Save: actual editor, client, hook and cache acknowledgement", () => {
	it.each(["pending", "failed"] as const)(
		"control: exact 200 success:true confirms edited rows despite a %s following GET",
		async (read) => {
			const { client, writes, reads } = fixture(
				() => json({ success: true, privateDiagnostic: privateDetail }),
				{ read },
			);
			editWindow();
			fireEvent.click(screen.getByRole("button", { name: "Aggregate Security: Login Failed" }));
			save();
			await settled(client);
			expect(writes).toEqual([
				{
					path: "/api/notifications/aggregation",
					method: "PUT",
					payload: {
						configs: [
							{
								eventType: "HUNT_CONTENT_FOUND",
								windowSeconds: 600,
								maxBatchSize: 10,
								enabled: true,
							},
							{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: false },
						],
					},
				},
			]);
			expect(cached(client)).toEqual([
				{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 600, maxBatchSize: 10, enabled: true },
				{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: false },
			]);
			expect(reads.length).toBeGreaterThan(0);
			expect(saveButton()).not.toBeInTheDocument();
			expect(windowInput()).toBeEnabled();
			expect(document.body).not.toHaveTextContent(privateDetail);
			// A subsequent edit is possible even while the independent GET hangs.
			fireEvent.change(windowInput(), { target: { value: "900" } });
			expect(windowInput()).toHaveValue("900");
			expect(saveButton()).toBeEnabled();
			expect(writes).toHaveLength(1);
		},
	);

	it("control: valid acknowledgement preserves an untouched known row", async () => {
		const { client, writes } = fixture(() => json({ success: true }));
		editWindow();
		save();
		await settled(client);
		expect(cached(client)).toEqual(editedCache);
		expect(writes).toEqual([{ path, method: "PUT", payload: editedPayload }]);
		expect(saveButton()).not.toBeInTheDocument();
		expect(
			screen.getByRole("combobox", { name: "Security: Login Failed aggregation window" }),
		).toHaveValue("60");
	});

	it.each([
		["201 with success:true", () => json({ success: true }, 201)],
		["204 bodyless", () => new Response(null, { status: 204 })],
		["null", () => json(null)],
		["false success", () => json({ success: false })],
		["missing success", () => json({ privateDiagnostic: privateDetail })],
		["non-boolean success", () => json({ success: "true" })],
		["200 bodyless", () => new Response(null, { status: 200 })],
		[
			"malformed JSON",
			() => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
		],
	] as const)(
		"retains draft and confirmed cache for unverified acknowledgement: %s",
		async (_name, reply) => {
			const { client, writes } = fixture(reply);
			editWindow();
			save();
			await settled(client);
			expectRetainedDraft(client);
			expectUnknownGuidance();
			expect.soft(saveButton()).toBeDisabled();
			expect(writes).toEqual([{ path, method: "PUT", payload: editedPayload }]);
			expectSanitizedUnknown(client.getMutationCache().getAll()[0]!.state.error);
		},
	);

	it.each([
		["lost transport acknowledgement", () => Promise.reject(new Error(privateDetail))],
		["503", () => json({ message: privateDetail, detail: privateDetail }, 503)],
		["408", () => json({ message: privateDetail }, 408)],
	] as const)(
		"locks an unknown %s outcome until explicit read-only settings review",
		async (_name, reply) => {
			const { client, writes } = fixture(reply);
			editWindow();
			save();
			await settled(client);
			expectRetainedDraft(client);
			expectUnknownGuidance();
			expect.soft(saveButton()).toBeDisabled();
			expect(writes).toHaveLength(1);
			expectSanitizedUnknown(client.getMutationCache().getAll()[0]!.state.error);
			expect.soft(reviewButton()).toBeInTheDocument();
		},
	);

	it("failed read-only review retains the unknown-outcome write lock and draft", async () => {
		const { client, writes, reads, reviewReads } = fixture(() =>
			json({ message: privateDetail }, 503),
		);
		editWindow();
		save();
		await settled(client);
		reviewReads("failed");
		const review = reviewButton();
		expect.soft(review).toBeInTheDocument();
		if (review) {
			fireEvent.click(review);
			await waitFor(() =>
				expect(client.getQueryState(notificationKeys.aggregation)?.status).toBe("error"),
			);
			expect(reads.length).toBeGreaterThan(0);
		}
		expectRetainedDraft(client);
		expect.soft(saveButton()).toBeDisabled();
		expectUnknownGuidance();
		expect(writes).toHaveLength(1);
	});

	it("successful read-only review permits a deliberate save without claiming the earlier write committed", async () => {
		const { client, writes, reads, reviewReads } = fixture((attempt) =>
			attempt === 1 ? json({ message: privateDetail }, 503) : json({ success: true }),
		);
		editWindow();
		save();
		await settled(client);
		reviewReads("baseline");
		const review = reviewButton();
		expect.soft(review).toBeInTheDocument();
		if (!review) return;
		fireEvent.click(review);
		await waitFor(() => expect(saveButton()).toBeEnabled());
		expect(reads.length).toBeGreaterThan(0);
		expectRetainedDraft(client);
		expect(writes).toHaveLength(1);
		expect(document.body).not.toHaveTextContent(/changes saved|successfully saved/i);
		save();
		await settled(client, 2);
		expect(writes).toEqual([
			{ path, method: "PUT", payload: editedPayload },
			{ path, method: "PUT", payload: editedPayload },
		]);
		expect(saveButton()).not.toBeInTheDocument();
	});

	it.each([400, 409])(
		"control: known rejected %i retains edits and permits a corrected deliberate retry",
		async (status) => {
			const { client, writes } = fixture((attempt) =>
				attempt === 1 ? json({ message: privateDetail }, status) : json({ success: true }),
			);
			editWindow();
			save();
			await settled(client);
			expectRetainedDraft(client);
			expect(saveButton()).toBeEnabled();
			expect(document.body).not.toHaveTextContent(privateDetail);
			fireEvent.change(windowInput(), { target: { value: "900" } });
			save();
			await settled(client, 2);
			expect(writes).toEqual([
				{ path, method: "PUT", payload: editedPayload },
				{
					path,
					method: "PUT",
					payload: {
						configs: [
							{
								eventType: "HUNT_CONTENT_FOUND",
								windowSeconds: 900,
								maxBatchSize: 10,
								enabled: true,
							},
						],
					},
				},
			]);
			expect(saveButton()).not.toBeInTheDocument();
		},
	);

	it("fences two same-turn clicks while the first PUT acknowledgement is held", async () => {
		const { client, writes } = fixture(
			() =>
				new Promise<Response>((resolve) => releases.push(() => resolve(json({ success: true })))),
		);
		editWindow();
		const button = screen.getByRole("button", { name: "Save Changes" });
		act(() => {
			button.click();
			button.click();
		});
		await waitFor(() => expect(writes.length).toBeGreaterThan(0));
		expect.soft(writes).toHaveLength(1);
		expect.soft(client.getMutationCache().getAll()).toHaveLength(1);
		expect(cached(client)).toEqual(baseline);
		expect(saveButton()).toBeDisabled();
	});

	it("control: a held single save isolates later attempted edits from acknowledgement", async () => {
		let finish: (() => void) | undefined;
		const { client, writes } = fixture(
			() =>
				new Promise<Response>((resolve) => {
					finish = () => resolve(json({ success: true }));
					releases.push(finish);
				}),
		);
		editWindow();
		save();
		await waitFor(() => expect(finish).toBeDefined());
		expect(windowInput()).toBeDisabled();
		expect(
			screen.getByRole("spinbutton", { name: "Hunt: Content Found maximum batch size" }),
		).toBeDisabled();
		expect(screen.getByRole("button", { name: "Aggregate Hunt: Content Found" })).toBeDisabled();
		fireEvent.change(windowInput(), { target: { value: "900" } });
		expect(cached(client)).toEqual(baseline);
		await act(async () => finish?.());
		await settled(client);
		expect(writes).toEqual([{ path, method: "PUT", payload: editedPayload }]);
		expect(cached(client)).toEqual(editedCache);
		expect(windowInput()).toHaveValue("600");
		expect(saveButton()).not.toBeInTheDocument();
	});

	it("custom mutation-retry policy: does not automatically replay an unverified PUT", async () => {
		const { client, writes } = fixture(() => json({ message: privateDetail }, 503), {
			mutationRetry: true,
		});
		editWindow();
		save();
		await settled(client);
		expect.soft(writes).toHaveLength(1);
		expectRetainedDraft(client);
	});

	it("client admission strips extra acknowledged response fields before callers can retain them", async () => {
		fixture(() => json({ success: true, privateDiagnostic: privateDetail }));
		const result = await notificationsApi.updateAggregationConfigs([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 600, maxBatchSize: 10, enabled: true },
		]);
		expect(result).toEqual({ success: true });
	});

	it("explicit review shows checked saved values separately from the retained edited row", async () => {
		const { client, writes, reviewReads } = fixture(() => json({ message: privateDetail }, 503));
		editWindow();
		save();
		await settled(client);
		reviewReads("baseline", [
			{
				eventType: "HUNT_CONTENT_FOUND",
				windowSeconds: 120,
				maxBatchSize: 7,
				enabled: false,
				privateDiagnostic: privateDetail,
			},
			{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
		]);
		const review = reviewButton();
		expect.soft(review).toBeInTheDocument();
		if (!review) return;
		fireEvent.click(review);
		await waitFor(() => expect(saveButton()).toBeEnabled());
		expect(windowInput()).toHaveValue("600");
		expect(cached(client)).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 120, maxBatchSize: 7, enabled: false },
			{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
		]);
		const checked = screen.getByText(/checked saved.*disabled.*120.*7/i);
		expect(checked).toBeInTheDocument();
		expect(document.body).toHaveTextContent(/earlier.*unverified|earlier.*not.*verified/i);
		expect(document.body).not.toHaveTextContent(privateDetail);
		expect(writes).toHaveLength(1);
	});

	it("an empty reviewed list labels an edited row not returned without claiming the prior write failed", async () => {
		const { client, writes, reviewReads } = fixture(() => json({ message: privateDetail }, 503));
		editWindow();
		save();
		await settled(client);
		reviewReads("baseline", []);
		const review = reviewButton();
		expect.soft(review).toBeInTheDocument();
		if (!review) return;
		fireEvent.click(review);
		await waitFor(() => expect(saveButton()).toBeEnabled());
		expect(windowInput()).toHaveValue("600");
		expect(document.body).toHaveTextContent(/checked saved.*not returned/i);
		expect(document.body).toHaveTextContent(/earlier.*unverified|earlier.*not.*verified/i);
		expect(cached(client)).toEqual([]);
		expect(writes).toHaveLength(1);
	});

	it.each([
		["null", null],
		["duplicate event identity", [baseline[0], baseline[0]]],
		["incomplete row", [{ eventType: "HUNT_CONTENT_FOUND", enabled: true }]],
		[
			"unknown event key",
			[{ eventType: "SYNTHETIC_UNKNOWN_EVENT", windowSeconds: 60, maxBatchSize: 2, enabled: true }],
		],
		[
			"fractional numeric metadata",
			[{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 60.5, maxBatchSize: 2, enabled: true }],
		],
	] as const)(
		"review-only list admission rejects %s before publishing or unlocking",
		async (_name, body) => {
			const { client, writes, reviewReads } = fixture(() => json({ message: privateDetail }, 503));
			editWindow();
			save();
			await settled(client);
			reviewReads("baseline", body);
			const review = reviewButton();
			expect.soft(review).toBeInTheDocument();
			if (!review) return;
			fireEvent.click(review);
			await waitFor(() =>
				expect(client.getQueryState(notificationKeys.aggregation)?.status).toBe("error"),
			);
			expectRetainedDraft(client);
			expect(saveButton()).toBeDisabled();
			expect(document.body).toHaveTextContent(/couldn't.*review|could not.*review|review.*failed/i);
			expect(writes).toHaveLength(1);
		},
	);

	it("review-only admission accepts integer legacy metadata without applying creation ranges", async () => {
		const { client, writes, reviewReads } = fixture(() => json({ message: privateDetail }, 503));
		editWindow();
		save();
		await settled(client);
		reviewReads("baseline", [
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 17, maxBatchSize: 1, enabled: true },
		]);
		const review = reviewButton();
		expect.soft(review).toBeInTheDocument();
		if (!review) return;
		fireEvent.click(review);
		await waitFor(() => expect(saveButton()).toBeEnabled());
		expect(windowInput()).toHaveValue("600");
		expect(document.body).toHaveTextContent(/checked saved.*enabled.*17.*1/i);
		expect(cached(client)).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 17, maxBatchSize: 1, enabled: true },
		]);
		expect(writes).toHaveLength(1);
	});

	it("same-turn local edit after dispatch cannot be discarded by that save's acknowledgement", async () => {
		let finish: (() => void) | undefined;
		const { client, writes } = fixture(
			() =>
				new Promise<Response>((resolve) => {
					finish = () => resolve(json({ success: true }));
					releases.push(finish);
				}),
		);
		editWindow();
		const button = screen.getByRole("button", { name: "Save Changes" });
		const input = windowInput();
		act(() => {
			button.click();
			fireEvent.change(input, { target: { value: "900" } });
		});
		await waitFor(() => expect(finish).toBeDefined());
		expect.soft(windowInput()).toHaveValue("600");
		await act(async () => finish?.());
		await settled(client);
		expect(writes).toEqual([{ path, method: "PUT", payload: editedPayload }]);
		expect(cached(client)).toEqual(editedCache);
		expect(windowInput()).toHaveValue("600");
		expect(saveButton()).not.toBeInTheDocument();
	});

	it("old save completion updates confirmed cache without clearing a remounted editor's new draft", async () => {
		let finish: (() => void) | undefined;
		const { client, writes, view } = fixture(
			() =>
				new Promise<Response>((resolve) => {
					finish = () => resolve(json({ success: true }));
					releases.push(finish);
				}),
		);
		editWindow();
		save();
		await waitFor(() => expect(finish).toBeDefined());
		view.unmount();
		mountEditor(client);
		fireEvent.change(windowInput(), { target: { value: "900" } });
		await act(async () => finish?.());
		await settled(client);
		expect(windowInput()).toHaveValue("900");
		expect(saveButton()).toBeEnabled();
		expect(cached(client)).toEqual(editedCache);
		expect(writes).toHaveLength(1);
	});

	it("new edits after an unknown save cannot reset its outcome or unlock another write", async () => {
		const { client, writes } = fixture(() => json({ message: privateDetail }, 503));
		editWindow();
		save();
		await settled(client);
		fireEvent.change(windowInput(), { target: { value: "900" } });
		expect(windowInput()).toHaveValue("900");
		expect.soft(saveButton()).toBeDisabled();
		expectUnknownGuidance();
		expect.soft(reviewButton()).toBeInTheDocument();
		expect(cached(client)).toEqual(baseline);
		expect(writes).toHaveLength(1);
	});

	it("a failed subsequent explicit review restores the unknown-outcome save lock", async () => {
		const { client, writes, reviewReads } = fixture(() => json({ message: privateDetail }, 503));
		editWindow();
		save();
		await settled(client);
		reviewReads("baseline");
		fireEvent.click(screen.getByRole("button", { name: /review current aggregation settings/i }));
		await waitFor(() => expect(saveButton()).toBeEnabled());
		reviewReads("failed");
		fireEvent.click(screen.getByRole("button", { name: /review current aggregation settings/i }));
		await waitFor(() =>
			expect(client.getQueryState(notificationKeys.aggregation)?.status).toBe("error"),
		);
		expectRetainedDraft(client);
		expect(saveButton()).toBeDisabled();
		expect(document.body).not.toHaveTextContent(privateDetail);
		expect(writes).toHaveLength(1);
	});
});
