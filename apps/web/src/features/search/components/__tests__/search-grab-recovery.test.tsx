import type { SearchGrabStatus, SearchResult } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useSearchGrabRecovery } from "../../hooks/use-search-grab-recovery";
import { useSearchState } from "../../hooks/use-search-state";
import { SearchClient } from "../search-client";
import { SearchResultsTable } from "../search-results-table";

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#fff", to: "#aaa", glow: "#fff" } }),
}));

const rows: SearchResult[] = [
	{
		id: "PRIVATE_GUID",
		title: "PRIVATE_TITLE",
		indexer: "PRIVATE_INDEXER",
		indexerId: 7,
		protocol: "torrent",
		instanceId: "owned-instance",
		instanceName: "PRIVATE_CONNECTION",
		grabSelector: "sg1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	},
];
const clients: QueryClient[] = [];
beforeEach(() => window.localStorage.clear());
afterEach(() => {
	cleanup();
	clients.forEach((client) => {
		client.clear();
	});
	clients.length = 0;
	vi.unstubAllGlobals();
});
it("actual table exposes read status before enabling an explicit Grab", async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				JSON.stringify({
					results: [{ resultIndex: 0, availability: "not-recorded", status: null }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
	);
	function Harness() {
		const state = useSearchState();
		const recovery = useSearchGrabRecovery(rows, state.actions);
		return (
			<SearchResultsTable
				results={rows}
				onGrab={recovery.handleGrab}
				getGrabState={recovery.getRowState}
			/>
		);
	}
	render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>
				<Harness />
			</IncognitoProvider>
		</QueryClientProvider>,
	);
	await waitFor(() =>
		expect(screen.getByText(/No dashboard submission recorded/i)).toBeInTheDocument(),
	);
	expect(screen.getByRole("button", { name: "Grab" })).toBeEnabled();
	client.clear();
});

const predecessor = "11111111-1111-4111-8111-111111111111";
const priorIntent = "22222222-2222-4222-8222-222222222222";
function status(state: SearchGrabStatus["state"], attemptId = predecessor): SearchGrabStatus {
	return {
		attemptId,
		intentId: priorIntent,
		state,
		requestedAt: "2026-10-10T00:00:00.000Z",
		dispatchedAt: "2026-10-10T00:00:01.000Z",
		completedAt: ["acknowledged", "rejected"].includes(state) ? "2026-10-10T00:00:02.000Z" : null,
		outcomeCategory:
			state === "uncertain"
				? "transport-unconfirmed"
				: state === "rejected"
					? "provider-rejected"
					: null,
		nextAction:
			state === "uncertain"
				? "inspect-before-confirmed-retry"
				: state === "acknowledged"
					? "none"
					: state === "rejected"
						? "new-search"
						: "observe-status",
	};
}
type ResultObservation =
	| { availability: "recorded"; status: SearchGrabStatus }
	| { availability: "not-recorded" | "unavailable"; status: null };
async function populatedClient(
	incognito = false,
	initial: ResultObservation = { availability: "recorded", status: status("uncertain") },
	openReview = true,
) {
	if (incognito) window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	const sends: Array<Record<string, unknown>> = [];
	let observed = initial;
	let searchRows = rows;
	let loseReply = false;
	let recoveredIntent: SearchGrabStatus | undefined;
	const resultReads: Array<{ results: Array<{ instanceId: string; selector: string }> }> = [];
	const indexer = {
		id: 7,
		name: "PRIVATE_INDEXER",
		enable: true,
		protocol: "torrent",
		instanceId: "owned-instance",
		instanceName: "PRIVATE_CONNECTION",
	};
	const fetch = vi.fn(async (url: string, options: RequestInit) => {
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		if (url === "/api/search/indexers")
			return json({
				instances: [
					{
						instanceId: "owned-instance",
						instanceName: "PRIVATE_CONNECTION",
						success: true,
						data: [indexer],
					},
				],
				aggregated: [indexer],
				totalCount: 1,
				failedInstanceCount: 0,
			});
		if (url === "/api/search/query")
			return json({
				instances: [
					{
						instanceId: "owned-instance",
						instanceName: "PRIVATE_CONNECTION",
						success: true,
						data: searchRows,
						coverage: {
							receivedCount: 1,
							acceptedCount: 1,
							rejectedCount: 0,
							metadataIncompleteCount: 0,
						},
					},
				],
				aggregated: searchRows,
				totalCount: 1,
				failedInstanceCount: 0,
				coverage: {
					receivedCount: 1,
					acceptedCount: 1,
					rejectedCount: 0,
					metadataIncompleteCount: 0,
				},
			});
		if (url === "/api/search/grab/results/status") {
			resultReads.push(JSON.parse(String(options.body)));
			return json({ results: [{ resultIndex: 0, ...observed }] });
		}
		if (url === "/api/search/grab") {
			sends.push(JSON.parse(String(options.body)));
			if (loseReply) throw new Error("Synthetic lost reply");
			return new Response(null, { status: 204 });
		}
		if (url.startsWith("/api/search/grab/intents/"))
			return recoveredIntent ? json(recoveredIntent) : new Response(null, { status: 404 });
		throw new Error("Unexpected synthetic endpoint");
	});
	vi.stubGlobal("fetch", fetch);
	const rendered = render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>
				<SearchClient />
			</IncognitoProvider>
		</QueryClientProvider>,
	);
	const query = await screen.findByPlaceholderText("Search for movies, series, music, or books");
	fireEvent.change(query, { target: { value: "synthetic query" } });
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	const review = openReview
		? await screen.findByRole("button", { name: "Review duplicate risk" })
		: null;
	if (review) {
		review.focus();
		fireEvent.click(review);
		await screen.findByRole("dialog", { name: "Review duplicate submission risk" });
	} else
		await screen.findByText(
			/Submission rejected|No dashboard submission recorded|Earlier submission acknowledged/,
		);
	return {
		sends,
		resultReads,
		fetch,
		review: review!,
		unmount: rendered.unmount,
		loseNextReply: () => {
			loseReply = true;
		},
		recoverIntent: (value: SearchGrabStatus) => {
			recoveredIntent = value;
		},
		setStatus: (value: ReturnType<typeof status>) => {
			observed = { availability: "recorded", status: value };
		},
		setObservation: (value: ResultObservation) => {
			observed = value;
		},
		searchAgain: async (result: SearchResult = rows[0]!) => {
			searchRows = [result];
			const before = resultReads.length;
			fireEvent.click(screen.getByRole("button", { name: "Search" }));
			await waitFor(() => expect(resultReads.length).toBeGreaterThan(before));
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Checking status…" })).not.toBeInTheDocument(),
			);
		},
	};
}

it("actual plain-HTTP SearchClient renders and sends a UUIDv4 with getRandomValues only", async () => {
	vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
	vi.stubGlobal("isSecureContext", false);
	const flow = await populatedClient(false, { availability: "not-recorded", status: null }, false);
	expect(screen.getByRole("heading", { name: "Manual Search" })).toBeInTheDocument();
	const grab = screen.getByRole("button", { name: "Grab" });
	expect(grab).toBeEnabled();
	fireEvent.click(grab);
	await screen.findByRole("button", { name: "Sent" });
	expect(flow.sends).toHaveLength(1);
	expect(flow.sends[0]!.intentId).toMatch(
		/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
	);
	expect(flow.resultReads).toHaveLength(2);
});
it.each(["local", "recovered"])(
	"actual SearchClient does not show an old %s Sent receipt after a changed-binding fresh search",
	async (receipt) => {
		const flow = await populatedClient(
			false,
			{ availability: "not-recorded", status: null },
			false,
		);
		if (receipt === "recovered") flow.loseNextReply();
		fireEvent.click(screen.getByRole("button", { name: "Grab" }));
		await screen.findByRole("button", { name: receipt === "local" ? "Sent" : "Check status" });
		if (receipt === "recovered")
			flow.recoverIntent({
				...status("acknowledged"),
				intentId: flow.sends[0]!.intentId as string,
			});
		await flow.searchAgain({
			...rows[0]!,
			grabSelector: "sg1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
		});
		expect(screen.queryByRole("button", { name: "Sent" })).not.toBeInTheDocument();
		expect(
			screen.queryByText('Sent "PRIVATE_TITLE" to the download client.'),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Grab" })).toBeEnabled();
		expect(flow.sends).toHaveLength(1);
	},
);
it.each(["interrupted-before-dispatch", "provider-rejected"] as const)(
	"actual SearchClient offers explicit %s retry after a fresh search and after reload",
	async (outcomeCategory) => {
		const recorded: ResultObservation = {
			availability: "recorded",
			status: {
				...status("rejected"),
				outcomeCategory,
				dispatchedAt:
					outcomeCategory === "interrupted-before-dispatch" ? null : "2026-10-10T00:00:01.000Z",
			},
		};
		const flow = await populatedClient(false, recorded, false);
		expect(flow.sends).toHaveLength(0);
		await flow.searchAgain({
			...rows[0]!,
			grabSelector: "sg1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
		});
		const retry = screen.getByRole("button", { name: "Retry rejected grab" });
		expect(retry).toBeEnabled();
		expect(flow.sends).toHaveLength(0);
		const before = flow.resultReads.length;
		fireEvent.click(retry);
		fireEvent.click(retry);
		await screen.findByRole("button", { name: "Sent" });
		expect(flow.resultReads).toHaveLength(before + 1);
		expect(flow.sends).toHaveLength(1);
		expect(flow.sends[0]!.intentId).not.toBe(priorIntent);
		expect(flow.sends[0]!.retry).toBeUndefined();
		flow.unmount();
		const reloaded = await populatedClient(false, recorded, false);
		expect(screen.getByRole("button", { name: "Retry rejected grab" })).toBeEnabled();
		expect(reloaded.sends).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Retry rejected grab" }));
		await screen.findByRole("button", { name: "Sent" });
		expect(reloaded.sends).toHaveLength(1);
		expect(reloaded.sends[0]!.intentId).not.toBe(flow.sends[0]!.intentId);
	},
);

it.each([false, true])(
	"actual SearchClient explains a cancelled retry and keeps it disabled across search/reload (incognito %s)",
	async (incognito) => {
		const recorded: ResultObservation = {
			availability: "recorded",
			status: {
				...status("rejected"),
				dispatchedAt: null,
				outcomeCategory: "predecessor-acknowledged",
			},
		};
		const flow = await populatedClient(incognito, recorded, false);
		expect(screen.queryByRole("button", { name: "Retry rejected grab" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry cancelled" })).toBeDisabled();
		expect(
			screen.getByText(/earlier submission acknowledged.*retry was not sent/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Sent" })).not.toBeInTheDocument();
		await flow.searchAgain();
		expect(screen.getByRole("button", { name: "Retry cancelled" })).toBeDisabled();
		expect(flow.sends).toHaveLength(0);
		flow.unmount();
		const reloaded = await populatedClient(incognito, recorded, false);
		expect(screen.getByRole("button", { name: "Retry cancelled" })).toBeDisabled();
		expect(reloaded.sends).toHaveLength(0);
		if (incognito) expect(document.body.textContent).not.toContain("PRIVATE");
	},
);
it("actual SearchClient rechecks an ordinary retry and cancels it when an earlier ACK becomes known", async () => {
	const flow = await populatedClient(
		false,
		{ availability: "recorded", status: status("rejected") },
		false,
	);
	const retry = screen.getByRole("button", { name: "Retry rejected grab" });
	expect(retry).toBeEnabled();
	flow.setStatus({
		...status("rejected"),
		dispatchedAt: null,
		outcomeCategory: "predecessor-acknowledged",
	});
	const before = flow.resultReads.length;
	fireEvent.click(retry);
	await screen.findByRole("button", { name: "Retry cancelled" });
	expect(flow.resultReads).toHaveLength(before + 1);
	expect(flow.sends).toHaveLength(0);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Sent" })).not.toBeInTheDocument();
});
it("actual SearchClient cancels an open confirmed retry when an earlier ACK becomes known", async () => {
	const flow = await populatedClient();
	const dialog = screen.getByRole("dialog");
	fireEvent.click(within(dialog).getByRole("checkbox", { name: /understand.*duplicate/i }));
	flow.setStatus({
		...status("rejected"),
		dispatchedAt: null,
		outcomeCategory: "predecessor-acknowledged",
	});
	fireEvent.click(within(dialog).getByRole("button", { name: "Submit again" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(screen.getByRole("button", { name: "Retry cancelled" })).toBeDisabled();
	expect(flow.sends).toHaveLength(0);
	expect(screen.queryByRole("button", { name: "Sent" })).not.toBeInTheDocument();
});

// Removing the actual SearchClient hook/caller wiring must break these paths.
it("actual populated SearchClient requires unchecked affirmative consent and cancels without a send", async () => {
	const flow = await populatedClient();
	const dialog = screen.getByRole("dialog");
	expect(dialog).toHaveAccessibleDescription(/may already have reached.*duplicate/i);
	expect(
		within(dialog).getByRole("checkbox", { name: /understand.*duplicate/i }),
	).not.toBeChecked();
	expect(within(dialog).getByRole("button", { name: "Submit again" })).toBeDisabled();
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(flow.sends).toHaveLength(0);
	expect(flow.review).toHaveFocus();
});
it("actual SearchClient sends one exact new predecessor-linked intent after confirmation", async () => {
	const flow = await populatedClient();
	const dialog = screen.getByRole("dialog");
	fireEvent.click(within(dialog).getByRole("checkbox", { name: /understand.*duplicate/i }));
	const submit = within(dialog).getByRole("button", { name: "Submit again" });
	expect(submit).toBeEnabled();
	fireEvent.click(submit);
	fireEvent.click(submit);
	await waitFor(() => expect(flow.sends).toHaveLength(1));
	expect(flow.sends[0]).toMatchObject({
		instanceId: "owned-instance",
		selector: rows[0]!.grabSelector,
		retry: { predecessorId: predecessor, duplicateRiskConfirmed: true },
	});
	expect(flow.sends[0]!.intentId).not.toBe(priorIntent);
	expect(await screen.findByRole("button", { name: "Sent" })).toBeDisabled();
	expect(screen.getByText('Sent "PRIVATE_TITLE" to the download client.')).toBeInTheDocument();
});
it("actual incognito SearchClient keeps warning generic and resets consent on Escape and reopening", async () => {
	const flow = await populatedClient(true);
	let dialog = screen.getByRole("dialog");
	expect(dialog.textContent).not.toContain("PRIVATE");
	expect(screen.queryByText("PRIVATE_TITLE")).not.toBeInTheDocument();
	fireEvent.click(within(dialog).getByRole("checkbox", { name: /understand.*duplicate/i }));
	fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(flow.sends).toHaveLength(0);
	fireEvent.click(flow.review);
	dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
});
it("actual SearchClient prevents a confirmed send when an active successor appears", async () => {
	const flow = await populatedClient();
	const dialog = screen.getByRole("dialog");
	fireEvent.click(within(dialog).getByRole("checkbox"));
	flow.setStatus(status("submitting", "33333333-3333-4333-8333-333333333333"));
	fireEvent.click(within(dialog).getByRole("button", { name: "Submit again" }));
	await screen.findByText(/Submission is in progress/);
	expect(flow.sends).toHaveLength(0);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
