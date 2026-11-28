import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../../providers/color-theme-provider";
import { IncognitoProvider } from "../../../../../contexts/IncognitoContext";

vi.mock("../../../../../components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import * as quiApi from "../../../../../lib/api-client/qui";
import type { SeriesTorrentCopy } from "../../../../../lib/api-client/qui";
import { quiKeys } from "../../../../../lib/query-keys";
import { TrackersSection } from "../trackers-section";

const selector = "a".repeat(64);
const host = "private.tracker.example";

function makeCopy(overrides: Partial<SeriesTorrentCopy> = {}): SeriesTorrentCopy {
	return {
		quiInstanceId: "qui-1",
		qbitInstanceId: 7,
		infoHash: "a".repeat(40),
		name: "Torrent",
		role: "library",
		state: "seeding",
		progress: 1,
		size: 1024,
		ratio: 1,
		seedingTime: 0,
		uploadedTotal: 0,
		downloadedTotal: 0,
		numSeeds: 0,
		numLeechs: 0,
		dlSpeed: 0,
		upSpeed: 0,
		eta: 0,
		tags: [],
		category: "",
		savePath: "/data",
		addedOn: 0,
		completedOn: 0,
		priority: 0,
		quiUnreachable: false,
		trackerHostnames: [host],
		trackers: [],
		...overrides,
	} as SeriesTorrentCopy;
}

function makeClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function renderSection(ui: ReactNode, client = makeClient()) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QueryClientProvider client={client}>{ui}</QueryClientProvider>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

function tracker(
	overrides: Partial<
		Awaited<ReturnType<typeof quiApi.fetchQuiTorrentTrackers>>["trackers"][number]
	> = {},
) {
	return {
		trackerSelector: selector,
		hostname: host,
		port: null,
		tier: 0,
		status: 2,
		health: "working" as const,
		numSeeds: 2,
		numLeeches: 1,
		numPeers: 3,
		selectable: true,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	vi.spyOn(quiApi, "fetchQuiTorrentTrackers").mockResolvedValue({
		trackers: [tracker()],
	});
	vi.spyOn(quiApi, "postQuiRemoveTrackers").mockResolvedValue({ status: "success" });
	vi.spyOn(quiApi, "postQuiAddTrackers").mockResolvedValue({ status: "success" });
	vi.spyOn(quiApi, "postQuiEditTracker").mockResolvedValue({ status: "success" });
});

describe("TrackersSection — server-derived tracker recovery", () => {
	it("uses the selected opaque selector and does not optimistically remove the row", async () => {
		renderSection(<TrackersSection copy={makeCopy()} canAct />);
		await screen.findByRole("button", { name: `Remove tracker ${host} · tier 0` });
		fireEvent.click(screen.getByRole("button", { name: `Remove tracker ${host} · tier 0` }));
		await waitFor(() =>
			expect(quiApi.postQuiRemoveTrackers).toHaveBeenCalledWith({
				quiInstanceId: "qui-1",
				qbitInstanceId: 7,
				hash: "a".repeat(40),
				trackerSelectors: [selector],
			}),
		);
		// The displayed rows change only when the invalidated point read settles.
		expect(screen.getByRole("button", { name: `Remove tracker ${host} · tier 0` })).toBeTruthy();
	});

	it("does not expose a private host in incognito-visible text, labels, or attributes", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const { container } = renderSection(<TrackersSection copy={makeCopy()} canAct />);
		await screen.findByText(/LinuxTracker/);
		await waitFor(() => expect(container.innerHTML).not.toContain(host));
		for (const element of container.querySelectorAll("*")) {
			for (const attribute of Array.from(element.attributes)) {
				expect(attribute.value).not.toContain(host);
			}
		}
		expect(
			screen.getByRole("button", { name: "Remove tracker LinuxTracker · tier 0" }),
		).toBeTruthy();
	});

	it("keeps safe-label collisions explicitly nonselectable", async () => {
		vi.mocked(quiApi.fetchQuiTorrentTrackers).mockResolvedValue({
			trackers: [0, 1].map((i) =>
				tracker({
					trackerSelector: "b".repeat(63) + i,
					port: "443",
					selectable: false,
				}),
			),
		});
		renderSection(<TrackersSection copy={makeCopy()} canAct />);
		await screen.findAllByText(/ambiguous or unavailable/);
		for (const button of screen.getAllByRole("button", {
			name: `Remove tracker ${host}:443 · tier 0`,
		})) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
		}
		expect(quiApi.postQuiRemoveTrackers).not.toHaveBeenCalled();
	});

	it("distinguishes a real empty list from initial failure and offers retry", async () => {
		vi.mocked(quiApi.fetchQuiTorrentTrackers).mockResolvedValue({ trackers: [] });
		const empty = renderSection(<TrackersSection copy={makeCopy()} canAct />);
		await screen.findByText("No trackers");
		empty.unmount();

		vi.mocked(quiApi.fetchQuiTorrentTrackers).mockRejectedValueOnce(new Error("unavailable"));
		vi.mocked(quiApi.fetchQuiTorrentTrackers).mockResolvedValueOnce({ trackers: [] });
		renderSection(<TrackersSection copy={makeCopy()} canAct />);
		fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
		await screen.findByText("No trackers");
	});

	it.each([
		["unreachable copy", { quiUnreachable: true }],
		["missing qUI instance ID", { quiInstanceId: null }],
		["missing qBit instance ID", { qbitInstanceId: null }],
	])(
		"explains an unavailable target for %s without retry or mutation controls",
		async (_case, overrides) => {
			renderSection(<TrackersSection copy={makeCopy(overrides)} canAct />);
			await screen.findByText(
				/tracker list unavailable.*unreachable or missing its instance address/i,
			);
			expect(screen.queryByText("Loading trackers…")).toBeNull();
			expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
			expect(quiApi.fetchQuiTorrentTrackers).not.toHaveBeenCalled();
			expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(
				true,
			);
		},
	);

	it("shows active initial fetch as loading", async () => {
		let resolveFetch!: (value: Awaited<ReturnType<typeof quiApi.fetchQuiTorrentTrackers>>) => void;
		vi.mocked(quiApi.fetchQuiTorrentTrackers).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
		);
		renderSection(<TrackersSection copy={makeCopy()} canAct />);
		expect(screen.getByRole("status").textContent).toContain("Loading trackers");
		resolveFetch({ trackers: [tracker()] });
		await screen.findByText(`${host} · tier 0`);
	});

	it("marks cached rows as last-known when the copy is disabled", async () => {
		const client = makeClient();
		const copy = makeCopy({ quiUnreachable: true });
		client.setQueryData(quiKeys.torrentTrackers.byHash("qui-1", 7, copy.infoHash), {
			trackers: [tracker()],
		});
		renderSection(<TrackersSection copy={copy} canAct />, client);
		await screen.findByText(/showing last-known tracker data.*changes are disabled/i);
		expect(screen.getByText(`${host} · tier 0`)).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: `Remove tracker ${host} · tier 0` }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
	});

	it("keeps last-known rows visible after a failed refresh", async () => {
		const client = makeClient();
		const copy = makeCopy();
		client.setQueryData(quiKeys.torrentTrackers.byHash("qui-1", 7, copy.infoHash), {
			trackers: [tracker()],
		});
		vi.mocked(quiApi.fetchQuiTorrentTrackers).mockRejectedValueOnce(
			new Error("refresh unavailable"),
		);
		renderSection(<TrackersSection copy={copy} canAct />, client);
		await act(async () => {
			await client.invalidateQueries({
				queryKey: quiKeys.torrentTrackers.byHash("qui-1", 7, copy.infoHash),
			});
		});
		await screen.findByText(/refresh failed; showing last-known tracker data/i);
		expect(screen.getByText(`${host} · tier 0`)).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: `Remove tracker ${host} · tier 0` }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it.each(["9000", "8000"])(
		"gives same-host selectors distinct accessible names with second port %s",
		async (secondPort) => {
			const firstSelector = "c".repeat(64);
			const secondSelector = "d".repeat(64);
			vi.mocked(quiApi.fetchQuiTorrentTrackers).mockResolvedValue({
				trackers: [
					tracker({ trackerSelector: firstSelector, port: "8000", tier: 0 }),
					tracker({ trackerSelector: secondSelector, port: secondPort, tier: 1 }),
				],
			});
			renderSection(<TrackersSection copy={makeCopy()} canAct />);
			fireEvent.click(
				await screen.findByRole("button", { name: `Edit tracker ${host}:8000 · tier 0` }),
			);
			fireEvent.change(screen.getByRole("textbox", { name: "Replacement announce URL" }), {
				target: { value: "https://replacement.example/announce" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Save tracker" }));
			await waitFor(() =>
				expect(quiApi.postQuiEditTracker).toHaveBeenCalledWith(
					expect.objectContaining({ trackerSelector: firstSelector }),
				),
			);
			fireEvent.click(
				screen.getByRole("button", { name: `Remove tracker ${host}:${secondPort} · tier 1` }),
			);
			await waitFor(() =>
				expect(quiApi.postQuiRemoveTrackers).toHaveBeenCalledWith(
					expect.objectContaining({ trackerSelectors: [secondSelector] }),
				),
			);
			expect(
				screen.getByRole("button", { name: `Remove tracker ${host}:8000 · tier 0` }),
			).toBeTruthy();
			expect(
				screen.getByRole("button", { name: `Remove tracker ${host}:${secondPort} · tier 1` }),
			).toBeTruthy();
		},
	);

	it("invalidates and settles a point read after a rejected tracker mutation", async () => {
		const client = makeClient();
		vi.mocked(quiApi.postQuiRemoveTrackers).mockRejectedValueOnce(new Error("remove rejected"));
		renderSection(<TrackersSection copy={makeCopy()} canAct />, client);
		await screen.findByRole("button", { name: `Remove tracker ${host} · tier 0` });
		const fetchCallsBeforeMutation = vi.mocked(quiApi.fetchQuiTorrentTrackers).mock.calls.length;
		fireEvent.click(screen.getByRole("button", { name: `Remove tracker ${host} · tier 0` }));
		await waitFor(() =>
			expect(vi.mocked(quiApi.fetchQuiTorrentTrackers).mock.calls.length).toBeGreaterThan(
				fetchCallsBeforeMutation,
			),
		);
		expect(screen.getByRole("button", { name: `Remove tracker ${host} · tier 0` })).toBeTruthy();
	});

	it.each([
		["add", "success"],
		["add", "rejection"],
		["remove", "success"],
		["remove", "rejection"],
		["edit", "success"],
		["edit", "rejection"],
	] as const)(
		"refreshes exactly once after %s %s, retaining last-known rows until the read settles",
		async (operation, outcome) => {
			const client = makeClient();
			const copy = makeCopy();
			const queryKey = quiKeys.torrentTrackers.byHash("qui-1", 7, copy.infoHash);
			const mutation = deferred<{ status: "success" }>();
			const refresh = deferred<Awaited<ReturnType<typeof quiApi.fetchQuiTorrentTrackers>>>();
			const refreshedHost = "refreshed.tracker.example";
			const refreshedRows =
				outcome === "rejection"
					? [tracker({ numSeeds: 11 })]
					: operation === "remove"
						? []
						: [tracker({ hostname: refreshedHost, numSeeds: 11 })];
			const mounted = renderSection(<TrackersSection copy={copy} canAct />, client);
			try {
				const removeButton = await screen.findByRole("button", {
					name: `Remove tracker ${host} · tier 0`,
				});
				expect(quiApi.fetchQuiTorrentTrackers).toHaveBeenCalledTimes(1);
				vi.mocked(quiApi.fetchQuiTorrentTrackers).mockReturnValue(refresh.promise);
				if (operation === "add") {
					vi.mocked(quiApi.postQuiAddTrackers).mockReturnValueOnce(mutation.promise);
					fireEvent.change(screen.getByRole("textbox", { name: "New tracker announce URL" }), {
						target: { value: "https://new.example/announce" },
					});
					fireEvent.click(screen.getByRole("button", { name: "Add" }));
				} else if (operation === "remove") {
					vi.mocked(quiApi.postQuiRemoveTrackers).mockReturnValueOnce(mutation.promise);
					fireEvent.click(removeButton);
				} else {
					vi.mocked(quiApi.postQuiEditTracker).mockReturnValueOnce(mutation.promise);
					fireEvent.click(screen.getByRole("button", { name: `Edit tracker ${host} · tier 0` }));
					fireEvent.change(screen.getByRole("textbox", { name: "Replacement announce URL" }), {
						target: { value: "https://replacement.example/announce" },
					});
					fireEvent.click(screen.getByRole("button", { name: "Save tracker" }));
				}
				await waitFor(() =>
					expect(client.getMutationCache().getAll()[0]?.state.status).toBe("pending"),
				);
				expect(screen.getByText(`${host} · tier 0`)).toBeTruthy();
				await waitFor(() =>
					expect(
						(
							screen.getByRole("button", {
								name: operation === "edit" ? "Save tracker" : `Remove tracker ${host} · tier 0`,
							}) as HTMLButtonElement
						).disabled,
					).toBe(true),
				);
				await act(async () => {
					if (outcome === "success") mutation.resolve({ status: "success" });
					else mutation.reject(new Error("tracker mutation rejected"));
				});
				await waitFor(() =>
					expect(client.getMutationCache().getAll()[0]?.state.status).toBe(
						outcome === "success" ? "success" : "error",
					),
				);
				await screen.findByText(/refreshing; showing last-known tracker data/i);
				expect(screen.getByText(`${host} · tier 0`)).toBeTruthy();
				expect(client.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
				expect(quiApi.fetchQuiTorrentTrackers).toHaveBeenCalledTimes(2);
				for (const button of screen.getAllByRole("button", {
					name: /^(Add|Remove tracker|Save tracker)/,
				})) {
					expect((button as HTMLButtonElement).disabled).toBe(true);
				}
				await act(async () => refresh.resolve({ trackers: refreshedRows }));
				await waitFor(() => expect(client.getQueryState(queryKey)?.fetchStatus).toBe("idle"));
				if (outcome === "success" && operation === "remove") {
					await screen.findByText("No trackers");
					expect(screen.queryByText(`${host} · tier 0`)).toBeNull();
				} else {
					await screen.findByText("working · 11 seeds · 1 leeches");
					expect(
						screen.getByText(`${outcome === "rejection" ? host : refreshedHost} · tier 0`),
					).toBeTruthy();
					expect(
						(
							screen.getByRole("button", {
								name:
									operation === "edit" && outcome === "rejection"
										? "Save tracker"
										: `Remove tracker ${outcome === "rejection" ? host : refreshedHost} · tier 0`,
							}) as HTMLButtonElement
						).disabled,
					).toBe(false);
				}
				expect(screen.queryByText(/refreshing; showing last-known tracker data/i)).toBeNull();
				expect(quiApi.fetchQuiTorrentTrackers).toHaveBeenCalledTimes(2);
			} finally {
				mutation.resolve({ status: "success" });
				refresh.resolve({ trackers: refreshedRows });
				mounted.unmount();
				client.clear();
			}
		},
	);
});
