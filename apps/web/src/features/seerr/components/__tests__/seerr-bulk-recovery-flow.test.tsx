import type { SeerrRequest } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { ApprovalQueueTab } from "../approval-queue-tab";
import { RequestsHistoryTab } from "../requests-history-tab";

// Transport is the external API seam; component, hooks, QueryClient, client,
// request cards, notifications and selection state are maintained code.
const stamp = "2026-10-01T12:00:00Z";
const request = (id: number): SeerrRequest => ({
	id,
	status: 1,
	type: "movie",
	is4k: false,
	createdAt: stamp,
	updatedAt: stamp,
	media: {
		id,
		tmdbId: id,
		status: 1,
		title: `Synthetic ${id}`,
		createdAt: stamp,
		updatedAt: stamp,
	},
	requestedBy: {
		id: 5,
		displayName: "Synthetic viewer",
		createdAt: stamp,
		updatedAt: stamp,
		permissions: 1,
		requestCount: 3,
		userType: 1,
	},
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clients: QueryClient[] = [];
const violations: string[] = [];
type Action = "approve" | "decline" | "delete";
function fixture(
	reply: () => Response | Promise<Response>,
	tab: "queue" | "history" = "queue",
	deleteReply: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
) {
	const posts: { path: string; body: unknown }[] = [];
	const reads: string[] = [];
	const openOptions = vi.fn();
	let rows = [request(41), request(42), request(43)];
	let failRead = false;
	let currentReply = reply;
	let rowReply: () => Response | Promise<Response> = () => json({ ...request(41), status: 2 });
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(input),
			method = init.method ?? "GET";
		if (method === "GET" && /^\/api\/seerr\/requests\/(north|south)\?/.test(path)) {
			reads.push(path);
			if (failRead) return json({ message: "synthetic-private-read-diagnostic" }, 503);
			return json({
				pageInfo: { pages: 1, pageSize: 50, results: rows.length, page: 1 },
				results: rows,
			});
		}
		if (method === "POST" && /^\/api\/seerr\/requests\/(north|south)\/bulk$/.test(path)) {
			expect(init.credentials).toBe("include");
			expect(new Headers(init.headers).get("content-type")).toBe("application/json");
			posts.push({ path, body: JSON.parse(String(init.body)) });
			return currentReply();
		}
		if (method === "POST" && path === "/api/seerr/requests/north/41/approve") {
			posts.push({ path, body: null });
			return rowReply();
		}
		if (method === "POST" && /^\/api\/seerr\/requests\/(north|south)\/41\/decline$/.test(path)) {
			posts.push({ path, body: null });
			return json({ ...request(41), status: 3 });
		}
		if (method === "DELETE" && /^\/api\/seerr\/requests\/(north|south)\/41$/.test(path)) {
			posts.push({ path, body: null });
			return deleteReply();
		}
		if (method === "GET" && /^\/api\/seerr\/users\/(north|south)\?/.test(path)) {
			return json({ pageInfo: { pages: 1, pageSize: 50, results: 0, page: 1 }, results: [] });
		}
		// Optional requester popover reads are unrelated to bulk actions.
		if (method === "GET" && path.includes("/quota"))
			return json({ movie: { used: 0, limit: 0, days: 7 }, tv: { used: 0, limit: 0, days: 7 } });
		violations.push(`${method} ${path}`);
		throw Error("Unexpected synthetic API operation");
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
			mutations: { retry: false, gcTime: Infinity },
		},
	});
	clients.push(client);
	const tree = (instanceId: string) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{tab === "queue" ? (
						<ApprovalQueueTab instanceId={instanceId} onOpenApproveOptions={openOptions} />
					) : (
						<RequestsHistoryTab instanceId={instanceId} />
					)}
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const view = render(tree("north"));
	return {
		client,
		posts,
		reads,
		openOptions,
		rowReply: (value: typeof rowReply) => {
			rowReply = value;
		},
		rows: (value: SeerrRequest[]) => {
			rows = value;
		},
		failRead: (value: boolean) => {
			failRead = value;
		},
		reply: (value: typeof reply) => {
			currentReply = value;
		},
		switch: (id: string) => view.rerender(tree(id)),
	};
}
async function ready() {
	await screen.findByRole("checkbox", { name: "Select request for Synthetic 41" });
}
function selectAll() {
	fireEvent.click(screen.getByRole("checkbox", { name: "Select All" }));
}
function submit(action: Action) {
	fireEvent.click(
		screen.getByRole("button", {
			name:
				action === "approve" ? "Approve All" : action === "decline" ? "Decline All" : "Delete All",
		}),
	);
	if (action !== "approve")
		fireEvent.click(screen.getByRole("button", { name: `Confirm ${action} 3?` }));
}
async function settled(view: ReturnType<typeof fixture>, count = 1) {
	await waitFor(() => {
		expect(view.posts).toHaveLength(count);
		expect(view.client.isMutating()).toBe(0);
		expect(view.client.isFetching()).toBe(0);
	});
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	toast.dismiss();
	localStorage.clear();
	vi.unstubAllGlobals();
	expect(violations.splice(0)).toEqual([]);
});

describe("Seerr inline confirmation targets", () => {
	it.each([
		{ tab: "queue", action: "decline", suffix: "/decline", message: "Request declined" },
		{ tab: "queue", action: "delete", suffix: "", message: "Request deleted" },
		{ tab: "history", action: "delete", suffix: "", message: "Request deleted" },
	] as const)(
		"$tab $action requires confirmation on the current instance",
		async ({ tab, action, suffix, message }) => {
			const view = fixture(() => json(null), tab);
			const arm = () => {
				const button =
					action === "decline"
						? screen.getAllByRole("button", { name: "Decline" })[0]
						: tab === "history"
							? screen.getAllByRole("button", { name: "Delete request" })[0]
							: screen
									.getAllByRole("button", { name: "" })
									.find((button) => button.querySelector(".lucide-trash-2"));
				expect(button).toBeDefined();
				fireEvent.click(button!);
			};
			const confirm = () => screen.queryByRole("button", { name: /^Confirm$/ });
			await screen.findByText("Synthetic 41");
			view.switch("south");
			await screen.findByText("Synthetic 41");
			view.switch("north");
			await screen.findByText("Synthetic 41");
			arm();
			expect(confirm()).toBeInTheDocument();

			view.switch("south");
			expect(screen.getByText("Synthetic 41")).toBeInTheDocument();
			expect(confirm()).not.toBeInTheDocument();
			view.switch("north");
			expect(confirm()).not.toBeInTheDocument();
			view.switch("south");
			arm();
			expect(view.posts).toEqual([]);
			const readCount = view.reads.length;
			fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
			await settled(view);

			expect(view.posts).toEqual([{ path: `/api/seerr/requests/south/41${suffix}`, body: null }]);
			expect(view.reads.slice(readCount)).toEqual([
				expect.stringMatching(/^\/api\/seerr\/requests\/south\?/),
			]);
			expect(await screen.findByText(message)).toBeInTheDocument();
		},
	);

	it.each([
		{ action: "decline", label: "Decline All" },
		{ action: "delete", label: "Delete All" },
	] as const)(
		"bulk $action requires fresh confirmation after an instance switch",
		async ({ action, label }) => {
			const view = fixture(() =>
				json({
					results: [{ requestId: 41, success: true }],
					totalSuccess: 1,
					totalFailed: 0,
					totalUnknown: 0,
				}),
			);
			const arm = () => fireEvent.click(screen.getByRole("button", { name: label }));
			const confirm = { name: `Confirm ${action} 1?` };
			const select = () =>
				fireEvent.click(screen.getByRole("checkbox", { name: "Select request for Synthetic 41" }));
			await ready();
			select();
			arm();
			expect(screen.getByRole("button", confirm)).toBeInTheDocument();

			view.switch("south");
			await ready();
			select();
			expect(screen.queryByRole("button", confirm)).not.toBeInTheDocument();
			arm();
			expect(view.posts).toEqual([]);
			fireEvent.click(screen.getByRole("button", confirm));
			await settled(view);
			expect(view.posts).toEqual([
				{ path: "/api/seerr/requests/south/bulk", body: { action, requestIds: [41] } },
			]);
		},
	);

	it("bulk delete requires fresh confirmation when the selected targets change", async () => {
		const view = fixture(() =>
			json({
				results: [{ requestId: 42, success: true }],
				totalSuccess: 1,
				totalFailed: 0,
				totalUnknown: 0,
			}),
		);
		const select = (id: number) =>
			fireEvent.click(screen.getByRole("checkbox", { name: `Select request for Synthetic ${id}` }));
		const arm = () => fireEvent.click(screen.getByRole("button", { name: "Delete All" }));
		await ready();
		select(41);
		arm();
		expect(screen.getByRole("button", { name: "Confirm delete 1?" })).toBeInTheDocument();
		select(42);
		select(41);
		expect(screen.queryByRole("button", { name: "Confirm delete 1?" })).not.toBeInTheDocument();

		arm();
		expect(view.posts).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Confirm delete 1?" }));
		await settled(view);
		expect(view.posts).toEqual([
			{ path: "/api/seerr/requests/north/bulk", body: { action: "delete", requestIds: [42] } },
		]);
	});

	it("keeps history delete feedback for a request already submitted before switching", async () => {
		let release!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const view = fixture(
			() => json(null),
			"history",
			() => held,
		);
		await screen.findByText("Synthetic 41");
		fireEvent.click(screen.getAllByRole("button", { name: "Delete request" })[0]!);
		fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
		try {
			await waitFor(() => expect(view.posts).toHaveLength(1));
			view.switch("south");
			await screen.findByText("Synthetic 41");
			expect(screen.getAllByRole("button", { name: "Delete request" })[0]).toBeDisabled();
		} finally {
			await act(async () => release(new Response(null, { status: 204 })));
		}
		await settled(view);
		expect(view.posts).toEqual([{ path: "/api/seerr/requests/north/41", body: null }]);
		expect(await screen.findByText("Request deleted")).toBeInTheDocument();
	});
});

describe("maintained Seerr bulk request recovery", () => {
	it("a held row approval blocks bulk submission and conflicting row/options controls", async () => {
		let release!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const view = fixture(() =>
			json({ results: [], totalSuccess: 0, totalFailed: 0, totalUnknown: 0 }),
		);
		view.rowReply(() => held);
		await ready();
		selectAll();
		fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);
		try {
			await waitFor(() => expect(view.posts).toHaveLength(1));
			expect.soft(screen.getByRole("button", { name: "Approve All" })).toBeDisabled();
			expect.soft(screen.getAllByRole("button", { name: "Decline" })[0]).toBeDisabled();
			expect(screen.getAllByRole("button", { name: "Options" })[0]).toBeDisabled();
			fireEvent.click(screen.getAllByRole("button", { name: "Options" })[0]!);
			expect(view.openOptions).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "Approve All" }));
			expect
				.soft(view.posts)
				.toEqual([{ path: "/api/seerr/requests/north/41/approve", body: null }]);
			fireEvent.click(screen.getAllByRole("button", { name: "Preview request" })[0]!);
			expect(screen.getByRole("button", { name: "Close preview" })).toBeEnabled();
		} finally {
			await act(async () => release(json({ ...request(41), status: 2 })));
			await waitFor(() => expect(view.client.isMutating()).toBe(0));
		}
	});
	it.each([
		{},
		{
			results: [{ requestId: 41, success: true }],
			totalSuccess: 3,
			totalFailed: 0,
			totalUnknown: 0,
		},
	])(
		"well-formed but invalid bulk JSON remains generic unknown with current-state recovery: %j",
		async (body) => {
			const view = fixture(() => json(body));
			await ready();
			selectAll();
			submit("approve");
			await settled(view);
			expect(screen.getByRole("status")).toHaveTextContent("Outcome unknown for 3 requests.");
			expect(screen.getByRole("status")).toHaveTextContent("#41, #42, #43");
			expect(
				await screen.findByText("Outcome unknown. Check Seerr before retrying."),
			).toBeInTheDocument();
			expect(view.posts).toHaveLength(1);
			expect(screen.queryByText("3 selected")).not.toBeInTheDocument();
		},
	);
	it("merges repeated unknown IDs and preserves them through definite errors and another instance's success", async () => {
		const unknown = (ids: number[]) => ({
			results: ids.map((requestId) => ({ requestId, success: false, outcome: "unknown" })),
			totalSuccess: 0,
			totalFailed: 0,
			totalUnknown: ids.length,
		});
		const succeeded = (id: number) => ({
			results: [{ requestId: id, success: true }],
			totalSuccess: 1,
			totalFailed: 0,
			totalUnknown: 0,
		});
		const view = fixture(() => {
			view.rows([request(42), request(43)]);
			return json(
				{
					results: [
						{ requestId: 41, success: true },
						{ requestId: 42, success: false, outcome: "unknown" },
						{ requestId: 43, success: false, outcome: "unknown" },
					],
					totalSuccess: 1,
					totalFailed: 0,
					totalUnknown: 2,
				},
				207,
			);
		});
		const select = (id: number) =>
			fireEvent.click(screen.getByRole("checkbox", { name: `Select request for Synthetic ${id}` }));
		const approve = () => fireEvent.click(screen.getByRole("button", { name: "Approve All" }));
		await ready();
		selectAll();
		submit("approve");
		await settled(view);
		view.reply(() => json(unknown([42]), 207));
		select(42);
		approve();
		await settled(view, 2);
		expect(screen.getByRole("status")).toHaveTextContent("Outcome unknown for 2 requests.");
		view.reply(() => json({ message: "Synthetic refusal" }, 422));
		select(42);
		approve();
		await settled(view, 3);
		expect(screen.getByRole("status")).toHaveTextContent("#42, #43");
		view.switch("south");
		await screen.findByRole("checkbox", { name: "Select request for Synthetic 42" });
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		view.reply(() => json(succeeded(42)));
		select(42);
		approve();
		await settled(view, 4);
		view.switch("north");
		await screen.findByRole("checkbox", { name: "Select request for Synthetic 42" });
		expect(screen.getByRole("status")).toHaveTextContent("#42, #43");
		select(42);
		approve();
		await settled(view, 5);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Outcome unknown for 1 request. Check Seerr request #43 before retrying.",
		);
		view.reply(() => {
			view.rows([]);
			return json(succeeded(43));
		});
		select(43);
		approve();
		await settled(view, 6);
		expect(await screen.findByText("No Pending Requests")).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(
			screen.getByText("All caught up! New requests will appear here when users submit them."),
		).toBeInTheDocument();
		expect(view.posts.map((post) => ({ path: post.path, body: post.body }))).toEqual([
			{
				path: "/api/seerr/requests/north/bulk",
				body: { action: "approve", requestIds: [41, 42, 43] },
			},
			{ path: "/api/seerr/requests/north/bulk", body: { action: "approve", requestIds: [42] } },
			{ path: "/api/seerr/requests/north/bulk", body: { action: "approve", requestIds: [42] } },
			{ path: "/api/seerr/requests/south/bulk", body: { action: "approve", requestIds: [42] } },
			{ path: "/api/seerr/requests/north/bulk", body: { action: "approve", requestIds: [42] } },
			{ path: "/api/seerr/requests/north/bulk", body: { action: "approve", requestIds: [43] } },
		]);
	});
	it("retains late unknown acknowledgement on its original instance after switching away and back", async () => {
		let release!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const view = fixture(() => held);
		await ready();
		selectAll();
		submit("approve");
		try {
			await waitFor(() => expect(view.posts).toHaveLength(1));
			view.switch("south");
			await ready();
		} finally {
			await act(async () =>
				release(
					json(
						{
							results: [
								{ requestId: 41, success: false, outcome: "unknown" },
								{ requestId: 42, success: false, outcome: "unknown" },
								{ requestId: 43, success: false, outcome: "unknown" },
							],
							totalSuccess: 0,
							totalFailed: 0,
							totalUnknown: 3,
						},
						207,
					),
				),
			);
		}
		await settled(view);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		view.switch("north");
		await ready();
		expect(screen.getByRole("status")).toHaveTextContent("#41, #42, #43");
		expect(view.posts).toHaveLength(1);
	});
	// Catches a second request mutation targeting a row already in a pending bulk action.
	it("does not overlap a per-row approval with the same pending bulk target", async () => {
		let release!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const view = fixture(() => held);
		await ready();
		selectAll();
		submit("approve");
		try {
			await waitFor(() => expect(view.posts).toHaveLength(1));
			const approve = screen.getAllByRole("button", { name: "Approve" })[0]!;
			expect.soft(approve).toBeDisabled();
			expect(screen.getAllByRole("button", { name: "Options" })[0]).toBeDisabled();
			fireEvent.click(screen.getAllByRole("button", { name: "Options" })[0]!);
			expect(view.openOptions).not.toHaveBeenCalled();
			fireEvent.click(approve);
			await waitFor(() => expect(view.client.isMutating()).toBe(1));
			expect.soft(view.posts).toEqual([
				{
					path: "/api/seerr/requests/north/bulk",
					body: { action: "approve", requestIds: [41, 42, 43] },
				},
			]);
		} finally {
			await act(async () =>
				release(
					json({
						results: [
							{ requestId: 41, success: true },
							{ requestId: 42, success: true },
							{ requestId: 43, success: true },
						],
						totalSuccess: 3,
						totalFailed: 0,
						totalUnknown: 0,
					}),
				),
			);
			await waitFor(() => expect(view.client.isMutating()).toBe(0));
		}
	});
	// Catches treating a 207 as all-success or losing selected request coordinates.
	it.each(["approve", "decline", "delete"] as const)(
		"%s preserves mixed outcomes and retries only newly selected current rows",
		async (action) => {
			const view = fixture(() => {
				view.rows([request(42)]);
				return json(
					{
						results: [
							{ requestId: 41, success: true },
							{ requestId: 42, success: false },
							{ requestId: 43, success: false, outcome: "unknown" },
						],
						totalSuccess: 1,
						totalFailed: 1,
						totalUnknown: 1,
					},
					207,
				);
			});
			await ready();
			selectAll();
			submit(action);
			await settled(view);
			expect(view.posts).toEqual([
				{ path: "/api/seerr/requests/north/bulk", body: { action, requestIds: [41, 42, 43] } },
			]);
			expect(screen.getByRole("status")).toHaveTextContent(
				"Outcome unknown for 1 request. Check Seerr request #43 before retrying.",
			);
			expect(
				await screen.findByText("1 succeeded, 1 failed, 1 unknown. Check Seerr before retrying."),
			).toBeInTheDocument();
			expect(screen.getByText("1 pending request")).toBeInTheDocument();
			expect(screen.queryByText(/\d selected/)).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Approve All" })).not.toBeInTheDocument();
			view.reply(() => {
				view.rows([]);
				return json({
					results: [{ requestId: 42, success: true }],
					totalSuccess: 1,
					totalFailed: 0,
					totalUnknown: 0,
				});
			});
			selectAll();
			fireEvent.click(screen.getByRole("button", { name: "Approve All" }));
			await settled(view, 2);
			expect(view.posts[1]).toEqual({
				path: "/api/seerr/requests/north/bulk",
				body: { action: "approve", requestIds: [42] },
			});
			expect(await screen.findByText("No Pending Requests")).toBeInTheDocument();
			// Acknowledging #42 cannot settle the earlier unknown outcome for #43.
			expect
				.soft(screen.queryByRole("status"))
				.toHaveTextContent("Check Seerr request #43 before retrying.");
			expect
				.soft(
					screen.queryByText(
						"All caught up! New requests will appear here when users submit them.",
					),
				)
				.not.toBeInTheDocument();
		},
	);
	// Catches losing uncertainty after failed revalidation or replaying a POST on GET recovery.
	it.each(["lost acknowledgement", "unreadable acknowledgement"] as const)(
		"retains %s through failed GET and explicit read recovery without replay",
		async (mode) => {
			const view = fixture(() => {
				view.rows([]);
				view.failRead(true);
				if (mode === "lost acknowledgement") throw Error("synthetic-private-socket-diagnostic");
				return new Response("{synthetic-private-body", {
					headers: { "content-type": "application/json" },
				});
			});
			await ready();
			selectAll();
			submit("approve");
			await settled(view);
			expect(screen.getByRole("status")).toHaveTextContent("Outcome unknown for 3 requests.");
			expect(screen.getByRole("status")).toHaveTextContent("#41, #42, #43");
			expect(screen.getByText("Failed to Load Requests")).toBeInTheDocument();
			expect(screen.queryByText(/Approved 3/)).not.toBeInTheDocument();
			expect(document.body.textContent).not.toContain("synthetic-private");
			view.failRead(false);
			await act(async () => {
				await view.client.refetchQueries({ queryKey: ["seerr", "requests", "north"] });
			});
			expect(await screen.findByText("No Pending Requests")).toBeInTheDocument();
			expect(
				screen.getByText(
					"No pending rows are currently shown. Reconcile the unknown outcome in Seerr.",
				),
			).toBeInTheDocument();
			expect(screen.getByRole("status")).toHaveTextContent("Outcome unknown for 3 requests.");
			expect(view.posts).toHaveLength(1);
		},
	);
	// Catches a pending bulk re-entry or reusing the old instance's selected IDs.
	it("disables bulk actions while pending and isolates selection when instance changes", async () => {
		let release!: (response: Response) => void;
		const held = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const view = fixture(() => held);
		await ready();
		selectAll();
		submit("approve");
		try {
			await waitFor(() => expect(view.posts).toHaveLength(1));
			expect(screen.getByRole("button", { name: "Processing..." })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Decline All" })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: "Decline All" }));
			view.switch("south");
			await ready();
			expect(screen.queryByText("3 selected")).not.toBeInTheDocument();
			expect(view.posts).toHaveLength(1);
		} finally {
			await act(async () =>
				release(
					json({
						results: [
							{ requestId: 41, success: true },
							{ requestId: 42, success: true },
							{ requestId: 43, success: true },
						],
						totalSuccess: 3,
						totalFailed: 0,
						totalUnknown: 0,
					}),
				),
			);
		}
		await settled(view);
		selectAll();
		view.reply(() =>
			json(
				{
					results: [
						{ requestId: 41, success: false },
						{ requestId: 42, success: false },
						{ requestId: 43, success: false },
					],
					totalSuccess: 0,
					totalFailed: 3,
					totalUnknown: 0,
				},
				207,
			),
		);
		submit("approve");
		await settled(view, 2);
		expect(view.posts[1]).toEqual({
			path: "/api/seerr/requests/south/bulk",
			body: { action: "approve", requestIds: [41, 42, 43] },
		});
	});
});
