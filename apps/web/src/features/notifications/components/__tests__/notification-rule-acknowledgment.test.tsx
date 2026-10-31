import type { NotificationRuleResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";

type Operation = "create" | "update";
const listPath = "/api/notifications/rules";
const draftName = "Submitted synthetic draft";
const privateDetail = "synthetic-private-rule-ack-detail";
// Complete, hand-derived route DTOs; no production validator computes expectations.
const original: NotificationRuleResponse = {
	id: "target-rule",
	name: "Original synthetic rule",
	enabled: false,
	priority: 13,
	action: "suppress",
	conditions: [
		{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
		{ field: "metadata.count", operator: "greater_than", value: 0 },
		{ field: "metadata.tags", operator: "in", value: ["", "literal,comma"] },
	],
	targetChannelIds: null,
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-02T12:00:00.000Z",
};
const other: NotificationRuleResponse = {
	...original,
	id: "other-rule",
	name: "Other synthetic rule",
	enabled: true,
	priority: 21,
};
const baseline = [original, other];
function normalized(operation: Operation): NotificationRuleResponse {
	return {
		...original,
		id: operation === "create" ? "created-rule" : original.id,
		name: "Server normalized synthetic rule",
		enabled: operation === "create",
		priority: 2,
		updatedAt: "2026-10-06T12:00:00.000Z",
	};
}
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function acknowledgment(operation: Operation, body: unknown = normalized(operation)) {
	return json(body, operation === "create" ? 201 : 200);
}

const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const violations: string[] = [];

// Only external fetch is replaced. Real components, condition editor, hooks,
// client, query observers/cache, providers and Sonner remain mounted together.
function fixture(
	operation: Operation,
	reply: (attempt: number) => Response | Promise<Response>,
	options: {
		reread?: "pending" | "failed";
		mutationRetry?: boolean;
		listReply?: (attempt: number) => Response | Promise<Response>;
	} = {},
) {
	const writes: Array<{ method: string; path: string; payload: unknown }> = [];
	const reads: string[] = [];
	let allowReads = false;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input);
		const method = init.method ?? "GET";
		if (method === "GET" && path === "/api/notifications/channels") return json([]);
		if (method === "GET" && path === listPath) {
			reads.push(path);
			if (options.listReply) return options.listReply(reads.length);
			if (allowReads) return json(baseline);
			if (options.reread === "failed") return json({ message: privateDetail }, 503);
			return new Promise<Response>((resolve) => releases.push(() => resolve(json(baseline))));
		}
		if (
			(method === "POST" && path === listPath && operation === "create") ||
			(method === "PUT" && path === `${listPath}/${original.id}` && operation === "update")
		) {
			writes.push({ method, path, payload: JSON.parse(String(init.body)) });
			return reply(writes.length);
		}
		violations.push(`${method} ${path}`);
		throw new Error("Out-of-scope synthetic request");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				staleTime: 30_000,
				gcTime: 300_000,
				retry: 1,
				// Production retry count; zero delay keeps failed-read controls focused.
				retryDelay: 0,
				structuralSharing: true,
			},
			// RootProviders has no mutation override. This opt-in is a separate
			// resilience case, not a claim that production defaults retry writes.
			...(options.mutationRetry && { mutations: { retry: 1, retryDelay: 0 } }),
		},
	});
	clients.push(client);
	client.setQueryData(notificationKeys.rules, baseline);
	client.setQueryData(notificationKeys.channels, []);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationRulesTab />
					<Toaster theme="light" duration={Infinity} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		client,
		writes,
		reads,
		allowReads() {
			allowReads = true;
		},
	};
}
function row(name = original.name) {
	const element = screen.getByText(name).closest(".rounded-xl");
	if (!(element instanceof HTMLElement)) throw new Error("Actual rule row missing");
	return within(element);
}
function cached(client: QueryClient) {
	return client.getQueryData<NotificationRuleResponse[]>(notificationKeys.rules);
}
function saveButton(operation: Operation) {
	return screen.queryByRole("button", {
		name: operation === "create" ? "Create Rule" : "Update Rule",
	});
}
function openDraft(operation: Operation) {
	if (operation === "create") {
		fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
		// A numeric zero is explicit typed input, never Number("").
		fireEvent.change(screen.getByLabelText("Value type"), { target: { value: "number" } });
		fireEvent.change(screen.getByLabelText("Condition value"), { target: { value: "0" } });
	} else fireEvent.click(row().getByTitle("Edit rule"));
	fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: draftName } });
	fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
}
async function settled(client: QueryClient) {
	await waitFor(() => {
		const mutations = client.getMutationCache().getAll();
		expect(mutations).toHaveLength(1);
		expect(["success", "error"]).toContain(mutations[0]!.state.status);
	});
	// Sonner schedules its real DOM publication after the mutation callback.
	await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
}
function expectDraft(operation: Operation) {
	expect.soft(saveButton(operation)).toBeInTheDocument();
	expect.soft(screen.queryByLabelText("Rule name")).toHaveValue(draftName);
	if (operation === "create") {
		expect.soft(screen.queryByLabelText("Value type")).toHaveValue("number");
		expect.soft(screen.queryByLabelText("Condition value")).toHaveValue("0");
	} else {
		expect
			.soft(
				screen.queryAllByLabelText("Value type").map((input) => (input as HTMLSelectElement).value),
			)
			.toEqual(["text", "number", "list"]);
		expect
			.soft(
				screen.queryAllByLabelText("List value").map((input) => (input as HTMLInputElement).value),
			)
			.toEqual(["", "literal,comma"]);
	}
}
function expectUncertainGuidance() {
	// Observable meaning, not a prescribed new message or future error class.
	expect
		.soft(document.body)
		.toHaveTextContent(/unverified|not.*verified|may.*saved|may.*completed/i);
	expect.soft(document.body).toHaveTextContent(/review|recheck|reload/i);
	expect.soft(document.body).not.toHaveTextContent(privateDetail);
}

afterEach(async () => {
	toast.dismiss();
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	await act(async () => {
		for (const release of releases.splice(0)) release();
	});
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});

describe("actual mounted notification rule save acknowledgment admission", () => {
	// Break caught: rejecting complete normalized metadata or awaiting a GET
	// before allowing an admitted acknowledgment to finish the editor.
	it.each(["create", "update"] as const)(
		"%s admits complete normalized metadata and typed conditions despite failed reread",
		async (operation) => {
			const value = fixture(operation, () => acknowledgment(operation), { reread: "failed" });
			openDraft(operation);
			fireEvent.click(saveButton(operation)!);
			await settled(value.client);
			await waitFor(() =>
				expect(value.client.getQueryState(notificationKeys.rules)?.status).toBe("error"),
			);
			expect(saveButton(operation)).not.toBeInTheDocument();
			expect(cached(value.client)).toEqual(
				operation === "create"
					? [normalized(operation), original, other]
					: [normalized(operation), other],
			);
			expect(screen.getByText("Server normalized synthetic rule")).toBeInTheDocument();
			expect(screen.getByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i);
			expect(value.writes).toHaveLength(1);
			expect(value.writes[0]!.payload).toMatchObject({
				name: draftName,
				priority: 2,
				conditions:
					operation === "create"
						? [{ field: "eventType", operator: "equals", value: 0 }]
						: [
								{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
								{ field: "metadata.count", operator: "greater_than", value: 0 },
								{ field: "metadata.tags", operator: "in", value: ["", "literal,comma"] },
							],
			});
			expect(value.reads).toHaveLength(2);
		},
	);

	const invalid: Array<{ operation: Operation; label: string; reply: () => Response }> = [
		{ operation: "create", label: "null201", reply: () => acknowledgment("create", null) },
		{
			operation: "create",
			label: "missing timestamp201",
			reply: () => acknowledgment("create", { ...normalized("create"), updatedAt: undefined }),
		},
		{
			operation: "create",
			label: "invalid nested condition201",
			reply: () =>
				acknowledgment("create", {
					...normalized("create"),
					conditions: [{ field: "eventType", operator: "equals", value: { privateDetail } }],
				}),
		},
		{ operation: "create", label: "unexpected POST200", reply: () => json(normalized("create")) },
		{
			operation: "create",
			label: "bodyless POST204",
			reply: () => new Response(null, { status: 204 }),
		},
		{
			operation: "update",
			label: "missing nullable field200",
			reply: () =>
				acknowledgment("update", { ...normalized("update"), targetChannelIds: undefined }),
		},
		{
			operation: "update",
			label: "malformed condition root200",
			reply: () => acknowledgment("update", { ...normalized("update"), conditions: {} }),
		},
		{
			operation: "update",
			label: "wrong target ID200",
			reply: () => acknowledgment("update", { ...normalized("update"), id: other.id }),
		},
		{
			operation: "update",
			label: "unexpected PUT201",
			reply: () => json(normalized("update"), 201),
		},
		{
			operation: "update",
			label: "bodyless PUT204",
			reply: () => new Response(null, { status: 204 }),
		},
	];
	// Break caught: a typed cast admitting invalid ACKs, wrong IDs/statuses,
	// false editor success, or cache publication before boundary validation.
	it.each(invalid)(
		"$operation retains good cache and draft for $label",
		async ({ operation, reply }) => {
			const value = fixture(operation, reply);
			openDraft(operation);
			fireEvent.click(saveButton(operation)!);
			await settled(value.client);
			expect.soft(cached(value.client)).toEqual(baseline);
			expectDraft(operation);
			expectUncertainGuidance();
			expect.soft(saveButton(operation)).toBeDisabled();
			expect(value.writes).toHaveLength(1);
		},
	);

	// Break caught: spreading response-only user/private data into shared cache.
	it.each(["create", "update"] as const)(
		"%s projects only safe DTO fields including nested conditions",
		async (operation) => {
			const safe = normalized(operation);
			const value = fixture(operation, () =>
				acknowledgment(operation, {
					...safe,
					userId: "synthetic-private-owner",
					diagnostics: privateDetail,
					conditions: safe.conditions.map((condition) => ({
						...condition,
						privateDiagnostic: privateDetail,
					})),
				}),
			);
			openDraft(operation);
			fireEvent.click(saveButton(operation)!);
			await settled(value.client);
			expect.soft(saveButton(operation)).not.toBeInTheDocument();
			expect(cached(value.client)).toEqual(
				operation === "create" ? [safe, original, other] : [safe, other],
			);
			expect(value.writes).toHaveLength(1);
		},
	);

	// Break caught: classifying a dispatched network/5xx outcome as a known
	// rejection or allowing another write without a deliberate read-only review.
	it.each([
		{
			operation: "create" as const,
			label: "lost network acknowledgment",
			reply: () => {
				throw new Error(privateDetail);
			},
		},
		{
			operation: "update" as const,
			label: "server503 acknowledgment",
			reply: () => json({ message: privateDetail }, 503),
		},
	])(
		"$operation preserves draft and offers read-only review after $label",
		async ({ operation, reply }) => {
			const value = fixture(operation, reply);
			openDraft(operation);
			fireEvent.click(saveButton(operation)!);
			await settled(value.client);
			expect.soft(cached(value.client)).toEqual(baseline);
			expectDraft(operation);
			expectUncertainGuidance();
			expect.soft(saveButton(operation)).toBeDisabled();
			const review = screen.queryByRole("button", {
				name: /(?:review|recheck|reload).*(?:rule|saved)/i,
			});
			expect.soft(review).toBeInTheDocument();
			expect(value.writes).toHaveLength(1);
			if (review) {
				value.allowReads();
				const readsBefore = value.reads.length;
				fireEvent.click(review);
				await waitFor(() => expect(value.reads.length).toBeGreaterThan(readsBefore));
				await waitFor(() =>
					expect(value.client.getQueryState(notificationKeys.rules)?.fetchStatus).toBe("idle"),
				);
				expect(value.writes).toHaveLength(1);
				expectDraft(operation);
				expectUncertainGuidance();
				// A current same-name row/list is not proof of the earlier write.
				expect(saveButton(operation)).toBeEnabled();
			}
		},
	);

	// Break caught: inheriting configured mutation retries instead of fencing a
	// potentially committed POST. Production defaults themselves do not retry.
	it("configured mutation retries cannot automatically replay a lost CREATE acknowledgment", async () => {
		const value = fixture(
			"create",
			() => {
				throw new Error(privateDetail);
			},
			{ mutationRetry: true },
		);
		openDraft("create");
		fireEvent.click(saveButton("create")!);
		await settled(value.client);
		expect.soft(value.writes).toHaveLength(1);
		expectDraft("create");
		expectUncertainGuidance();
	});

	// Break caught: treating a known conflict as ambiguous completion, losing its
	// draft, or preventing an explicit corrected retry of a rejected write.
	it.each(["create", "update"] as const)(
		"%s retains a rejected409 draft and permits deliberate corrected retry",
		async (operation) => {
			const value = fixture(operation, (attempt) =>
				attempt === 1
					? json({ message: "Synthetic rule settings conflict. Review your changes." }, 409)
					: acknowledgment(operation),
			);
			openDraft(operation);
			fireEvent.click(saveButton(operation)!);
			await settled(value.client);
			expectDraft(operation);
			expect(cached(value.client)).toEqual(baseline);
			expect(document.body).toHaveTextContent(/conflict|rejected|could not.*save/i);
			expect(document.body).not.toHaveTextContent(/unverified|may.*saved|may.*completed/i);
			expect(saveButton(operation)).toBeEnabled();
			expect(value.writes).toHaveLength(1);
			fireEvent.change(screen.getByLabelText("Rule name"), {
				target: { value: "Corrected synthetic draft" },
			});
			fireEvent.click(saveButton(operation)!);
			await waitFor(() => expect(saveButton(operation)).not.toBeInTheDocument());
			expect(value.writes).toHaveLength(2);
			expect(value.writes[1]!.payload).toMatchObject({ name: "Corrected synthetic draft" });
			expect(cached(value.client)).toEqual(
				operation === "create"
					? [normalized(operation), original, other]
					: [normalized(operation), other],
			);
		},
	);

	// Break caught: enabled-only PUTs bypassing admission or silently announcing
	// successful completion when a wrong-ID acknowledgment leaves cache intact.
	it.each([
		{ label: "wrong ID", body: { ...normalized("update"), id: other.id, enabled: true } },
		{ label: "invalid enabled metadata", body: { ...normalized("update"), enabled: "true" } },
	])("enabled-only toggle rejects $label without publishing success", async ({ body }) => {
		const value = fixture("update", () => acknowledgment("update", body));
		fireEvent.click(row().getByTitle("Enable rule"));
		await settled(value.client);
		expect.soft(cached(value.client)).toEqual(baseline);
		expectUncertainGuidance();
		expect(value.writes).toEqual([
			{ method: "PUT", path: `${listPath}/${original.id}`, payload: { enabled: true } },
		]);
	});
});

function heldResponse(cleanupResponse: () => Response) {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	releases.push(() => resolve(cleanupResponse()));
	return {
		promise,
		async finish(response: Response) {
			await act(async () => resolve(response));
		},
	};
}
function reviewButton() {
	return screen.getByRole("button", { name: /(?:review|recheck|reload).*(?:rule|saved)/i });
}

describe("rule acknowledgment recovery dispatch and lifetime guards", () => {
	// Break caught: failed GET releasing a replay lock, successful GET replaying
	// the write, or readback silently discarding an uncertain draft.
	it("failed review keeps the draft locked; successful review permits only a deliberate new CREATE", async () => {
		let readMode: "pending" | "failed" | "ready" = "pending";
		const pending = heldResponse(() => json(baseline));
		const value = fixture(
			"create",
			(attempt) =>
				attempt === 1 ? json({ message: privateDetail }, 503) : acknowledgment("create"),
			{
				listReply: () =>
					readMode === "pending"
						? pending.promise.then((response) => response.clone())
						: readMode === "failed"
							? json({ message: privateDetail }, 503)
							: json(baseline),
			},
		);
		openDraft("create");
		fireEvent.click(saveButton("create")!);
		await settled(value.client);
		expectDraft("create");
		expect(saveButton("create")).toBeDisabled();
		readMode = "failed";
		fireEvent.click(reviewButton());
		await waitFor(() => expect(reviewButton()).toBeEnabled());
		expect(saveButton("create")).toBeDisabled();
		expectDraft("create");
		expectUncertainGuidance();
		expect(value.writes).toHaveLength(1);
		readMode = "ready";
		fireEvent.click(reviewButton());
		await waitFor(() => expect(saveButton("create")).toBeEnabled());
		expectDraft("create");
		expectUncertainGuidance();
		expect(value.writes).toHaveLength(1);
		fireEvent.click(saveButton("create")!);
		await waitFor(() => expect(saveButton("create")).not.toBeInTheDocument());
		expect(value.writes).toHaveLength(2);
	});

	// Break caught: relying on a future isPending render to block duplicate
	// dispatch instead of fencing synchronously in the click handler.
	it.each(["create", "update"] as const)(
		"%s blocks two synchronous save clicks before pending render",
		async (operation) => {
			const pending = heldResponse(() => acknowledgment(operation));
			const value = fixture(operation, () => pending.promise);
			openDraft(operation);
			const button = saveButton(operation)!;
			act(() => {
				button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			await waitFor(() => expect(value.writes.length).toBeGreaterThan(0));
			expect(value.writes).toHaveLength(1);
			await pending.finish(acknowledgment(operation));
			await settled(value.client);
			expect(saveButton(operation)).not.toBeInTheDocument();
		},
	);

	// Break caught: an old successful save closing an editor opened after cancel.
	it("cancel/open-new-editor while CREATE is pending survives the old successful completion", async () => {
		const pending = heldResponse(() => acknowledgment("create"));
		const value = fixture("create", () => pending.promise);
		openDraft("create");
		fireEvent.click(saveButton("create")!);
		await waitFor(() => expect(value.writes).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(row().getByTitle("Edit rule"));
		fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "New editor draft" } });
		await pending.finish(acknowledgment("create"));
		await settled(value.client);
		expect(saveButton("update")).toBeInTheDocument();
		expect(screen.getByLabelText("Rule name")).toHaveValue("New editor draft");
		expect(value.writes).toHaveLength(1);
	});

	// Break caught: a review captured by an obsolete editor releasing the new
	// editor's uncertain-write lock when its eventual GET succeeds.
	it("cancel/open-new-editor while review is pending requires a current deliberate review", async () => {
		let reviewReady = false;
		const pending = heldResponse(() => json(baseline));
		const value = fixture("update", () => json({ message: privateDetail }, 503), {
			listReply: () =>
				reviewReady ? json(baseline) : pending.promise.then((response) => response.clone()),
		});
		openDraft("update");
		fireEvent.click(saveButton("update")!);
		await settled(value.client);
		fireEvent.click(reviewButton());
		await waitFor(() => expect(reviewButton()).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(row().getByTitle("Edit rule"));
		fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "New editor draft" } });
		await pending.finish(json(baseline));
		await waitFor(() => expect(reviewButton()).toBeEnabled());
		expect(saveButton("update")).toBeDisabled();
		expect(screen.getByLabelText("Rule name")).toHaveValue("New editor draft");
		expectUncertainGuidance();
		expect(value.writes).toHaveLength(1);
		reviewReady = true;
		fireEvent.click(reviewButton());
		await waitFor(() => expect(saveButton("update")).toBeEnabled());
		expect(screen.getByLabelText("Rule name")).toHaveValue("New editor draft");
		expect(value.writes).toHaveLength(1);
	});

	// Break caught: unknown-state errors retaining raw private data, privacy
	// changes exposing the preserved draft or permitting write dispatch.
	it("incognito during uncertainty hides and preserves draft and prevents save/toggle dispatch", async () => {
		const value = fixture("update", () => json({ message: privateDetail }, 503));
		openDraft("update");
		fireEvent.click(saveButton("update")!);
		await settled(value.client);
		act(() => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expect(screen.getByLabelText("Rule name")).toHaveValue("");
		expect(screen.getByLabelText("Rule name")).toBeDisabled();
		expect(
			screen.getAllByLabelText("List value").map((input) => (input as HTMLInputElement).value),
		).toEqual(["", ""]);
		expect(document.body).not.toHaveTextContent(draftName);
		expect(document.body).not.toHaveTextContent(privateDetail);
		expectUncertainGuidance();
		fireEvent.click(saveButton("update")!);
		fireEvent.click(screen.getByTitle("Enable rule"));
		expect(value.writes).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Turn off incognito to edit" }));
		expectDraft("update");
		expect(saveButton("update")).toBeDisabled();
		expect(value.writes).toHaveLength(1);
	});

	// Break caught: applying creation policy to a valid partial enabled-only PUT
	// acknowledgment instead of preserving structurally valid historical rows.
	it.each([
		{
			label: "complete typed metadata",
			body: { ...original, enabled: true, updatedAt: "2026-10-06T12:00:00.000Z" },
		},
		{
			label: "legacy metadata",
			body: {
				...original,
				name: "",
				priority: -1,
				conditions: [],
				enabled: true,
				quietHoursTimezone: "Legacy/Unknown",
			},
		},
	])("valid enabled-only toggle admits $label", async ({ body }) => {
		const value = fixture("update", () => acknowledgment("update", body));
		fireEvent.click(row().getByTitle("Enable rule"));
		await settled(value.client);
		expect(cached(value.client)).toEqual([body, other]);
		expect(document.body).not.toHaveTextContent(/unverified|not.*verified|may.*saved/i);
		expect(value.writes).toEqual([
			{ method: "PUT", path: `${listPath}/${original.id}`, payload: { enabled: true } },
		]);
	});

	// Break caught: treating arbitrary strings or calendar-rollover dates as
	// route-generated timestamps on an otherwise structurally complete ACK.
	it.each([
		{ operation: "create" as const, value: "not-a-timestamp" },
		{ operation: "update" as const, value: "2026-02-30T12:00:00.000Z" },
	])(
		"$operation retains draft/cache for invalid timestamp $value",
		async ({ operation, value: timestamp }) => {
			const value = fixture(operation, () =>
				acknowledgment(operation, { ...normalized(operation), updatedAt: timestamp }),
			);
			openDraft(operation);
			fireEvent.click(saveButton(operation)!);
			await settled(value.client);
			expect.soft(cached(value.client)).toEqual(baseline);
			expectDraft(operation);
			expectUncertainGuidance();
			expect(value.writes).toHaveLength(1);
		},
	);

	// Break caught: CREATE overwriting a good already-known ID while the
	// independent list refresh is still pending.
	it("complete CREATE acknowledgment cannot replace an already-known cache ID", async () => {
		const value = fixture("create", () =>
			acknowledgment("create", { ...normalized("create"), id: original.id }),
		);
		openDraft("create");
		fireEvent.click(saveButton("create")!);
		await settled(value.client);
		expect(saveButton("create")).not.toBeInTheDocument();
		expect(cached(value.client)).toEqual(baseline);
		expect(value.writes).toHaveLength(1);
	});
});
