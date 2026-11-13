import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../../contexts/IncognitoContext";
import type { SeriesTorrentCopy } from "../../../../../lib/api-client/qui";
import * as quiApi from "../../../../../lib/api-client/qui";
import { quiKeys } from "../../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../../providers/color-theme-provider";
import { TagsCategorySection } from "../tags-category-section";

vi.mock("../../../../../lib/api-client/qui");
vi.mock("../../../../../components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const clients: QueryClient[] = [];
const acknowledged = { status: "success", logRowCount: 1 } as const;
const copy: SeriesTorrentCopy = {
	quiInstanceId: "qui-1",
	qbitInstanceId: 7,
	infoHash: "a".repeat(40),
	name: "Synthetic torrent",
	role: "library",
	state: "seeding",
	progress: 1,
	torrentSizeBytes: "1",
	ratio: 1,
	seedingTime: 0,
	numSeeds: 0,
	numLeechs: 0,
	dlSpeedBps: 0,
	upSpeedBps: 0,
	tracker: null,
	trackerHostnames: [],
	trackers: [],
	trackerHealth: null,
	peerSources: { dht: false, pex: false, lsd: false },
	instanceName: "Synthetic qBit",
	tags: ["seed", "retain"],
	category: "existing",
	savePath: "/synthetic",
	addedOn: 0,
	quiUnreachable: false,
};

function mount(canAct = true, initialCopy = copy) {
	const refreshTorrent = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	const ui = (value: SeriesTorrentCopy) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<TagsCategorySection copy={value} canAct={canAct} refreshTorrent={refreshTorrent} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const rendered = render(ui(initialCopy));
	return {
		client,
		refreshTorrent,
		update: (value: SeriesTorrentCopy) => rendered.rerender(ui(value)),
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(quiApi.fetchQuiTags).mockResolvedValue({ tags: [] });
	vi.mocked(quiApi.fetchQuiCategories).mockResolvedValue({ categories: [] });
	vi.mocked(quiApi.postQuiTorrentAction).mockResolvedValue(acknowledged);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("Tag/category suggestions and mutation recovery with real hooks", () => {
	it("associates the visible field labels with their editable controls", () => {
		mount();
		expect(screen.getByLabelText("Tags")).toBe(screen.getByPlaceholderText("Pick or type a tag"));
		expect(screen.getByLabelText("Category")).toBe(
			screen.getByPlaceholderText("Pick or type a category"),
		);
	});
	it("distinguishes verified empty suggestions from unavailable reads", async () => {
		mount();
		await screen.findByText("No tag suggestions");
		await screen.findByText("No category suggestions");
		expect(screen.getByRole("button", { name: "Remove tag seed" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
	});

	it.each(["tag", "category"] as const)(
		"shows %s read failure and recovers only after explicit retry",
		async (kind) => {
			if (kind === "tag")
				vi.mocked(quiApi.fetchQuiTags).mockRejectedValueOnce(new Error("Synthetic unavailable"));
			else
				vi.mocked(quiApi.fetchQuiCategories).mockRejectedValueOnce(
					new Error("Synthetic unavailable"),
				);
			mount();
			await screen.findByText(new RegExp(`${kind} suggestions are unavailable`, "i"));
			expect(screen.queryByText(`No ${kind} suggestions`)).not.toBeInTheDocument();
			const fetcher = kind === "tag" ? quiApi.fetchQuiTags : quiApi.fetchQuiCategories;
			expect(fetcher).toHaveBeenCalledTimes(1);
			fireEvent.click(screen.getByRole("button", { name: `Retry ${kind} suggestions` }));
			await screen.findByText(`No ${kind} suggestions`);
			expect(fetcher).toHaveBeenCalledTimes(2);
			expect(quiApi.postQuiTorrentAction).not.toHaveBeenCalled();
		},
	);

	it("retains last-known suggestions after refresh failure instead of replacing them with empty", async () => {
		vi.mocked(quiApi.fetchQuiTags).mockResolvedValueOnce({ tags: ["known-tag"] });
		const { client } = mount();
		await waitFor(() =>
			expect(
				document.querySelector('#qui-tag-suggestions option[value="known-tag"]'),
			).not.toBeNull(),
		);
		vi.mocked(quiApi.fetchQuiTags).mockRejectedValueOnce(new Error("Synthetic refresh failure"));
		await act(async () => {
			await client.invalidateQueries({ queryKey: ["qui", "tags", "qui-1", 7] });
		});
		await screen.findByText(/showing last-known tag suggestions/i);
		expect(document.querySelector('#qui-tag-suggestions option[value="known-tag"]')).not.toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Retry tag suggestions" }));
		await screen.findByText("No tag suggestions");
		expect(document.querySelector('#qui-tag-suggestions option[value="known-tag"]')).toBeNull();
	});

	it("keeps confirmed tags and the edit draft after a rejected addition, then permits explicit recovery", async () => {
		vi.mocked(quiApi.postQuiTorrentAction).mockRejectedValueOnce(
			new Error("Synthetic uncertain outcome"),
		);
		const mounted = mount();
		const input = screen.getByPlaceholderText("Pick or type a tag");
		const panelKey = [...quiKeys.seriesTorrentsAll, "arr-1", 1];
		// Keep this inactive read cached until explicit fixture cleanup so a
		// zero-gc test client cannot erase the invalidation witness first.
		mounted.client.setQueryDefaults(panelKey, { gcTime: Infinity });
		mounted.client.setQueryData(panelKey, []);
		expect(mounted.client.getQueryState(panelKey)?.isInvalidated).toBe(false);
		fireEvent.change(input, { target: { value: "new-tag" } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		await screen.findByText(/change was not confirmed/i);
		expect(screen.queryByRole("button", { name: "Remove tag new-tag" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove tag seed" })).toBeInTheDocument();
		expect(input).toHaveValue("new-tag");
		expect(toast.success).not.toHaveBeenCalled();
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledWith({
			quiInstanceId: "qui-1",
			qbitInstanceId: 7,
			hash: "a".repeat(40),
			action: "setTags",
			payload: { tags: "seed,retain,new-tag" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		expect(input).toBeDisabled();
		mounted.refreshTorrent.mockResolvedValueOnce(true);
		fireEvent.click(screen.getByRole("button", { name: "Refresh torrent data" }));
		await waitFor(() => expect(input).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Tags updated"));
		expect(screen.queryByRole("button", { name: "Remove tag new-tag" })).not.toBeInTheDocument();
		expect(mounted.client.getQueryState(panelKey)?.isInvalidated).toBe(true);
		mounted.update({ ...copy, tags: ["seed", "retain", "new-tag"] });
		await screen.findByRole("button", { name: "Remove tag new-tag" });
		expect(input).toBeDisabled();
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledTimes(2);
		expect(input).toHaveValue("");
		expect(toast.success).toHaveBeenCalledWith("Tags updated");
	});

	it("does not remove a confirmed tag when the provider action rejects", async () => {
		vi.mocked(quiApi.postQuiTorrentAction).mockRejectedValueOnce(
			new Error("Synthetic rejected removal"),
		);
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Remove tag seed" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("button", { name: "Remove tag seed" })).toBeInTheDocument();
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledWith({
			quiInstanceId: "qui-1",
			qbitInstanceId: 7,
			hash: "a".repeat(40),
			action: "setTags",
			payload: { tags: "retain" },
		});
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("locks tag and category edits until the pending replacement settles", async () => {
		let resolve!: (value: typeof acknowledged) => void;
		vi.mocked(quiApi.postQuiTorrentAction).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const mounted = mount();
		const { client } = mounted;
		fireEvent.change(screen.getByPlaceholderText("Pick or type a tag"), {
			target: { value: "new-tag" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		try {
			await waitFor(() => expect(client.isMutating()).toBe(1));
			expect(screen.queryByRole("button", { name: "Remove tag new-tag" })).not.toBeInTheDocument();
			for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
			expect(screen.getByPlaceholderText("Pick or type a tag")).toBeDisabled();
			expect(screen.getByPlaceholderText("Pick or type a category")).toBeDisabled();
		} finally {
			await act(async () => resolve(acknowledged));
		}
		await screen.findByText(/showing last-known tags until torrent data refreshes/i);
		expect(screen.queryByRole("button", { name: "Remove tag new-tag" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
		mounted.update({ ...copy, tags: ["seed", "retain", "new-tag"] });
		await screen.findByRole("button", { name: "Remove tag new-tag" });
	});

	it("does not fabricate a local tag from the Enter key when actions are disallowed", async () => {
		mount(false);
		const input = screen.getByPlaceholderText("Pick or type a tag");
		fireEvent.change(input, { target: { value: "disallowed-tag" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(
			screen.queryByRole("button", { name: "Remove tag disallowed-tag" }),
		).not.toBeInTheDocument();
		expect(quiApi.postQuiTorrentAction).not.toHaveBeenCalled();
	});

	it("updates confirmed chips when a refreshed torrent copy reports new tags", async () => {
		const mounted = mount();
		mounted.update({ ...copy, tags: ["refreshed-tag"], category: "refreshed-category" });
		await screen.findByRole("button", { name: "Remove tag refreshed-tag" });
		expect(screen.getByPlaceholderText("Pick or type a category")).toHaveValue(
			"refreshed-category",
		);
		expect(screen.queryByRole("button", { name: "Remove tag seed" })).not.toBeInTheDocument();
		expect(quiApi.postQuiTorrentAction).not.toHaveBeenCalled();
	});

	it("does not carry an acknowledgement or category draft to another instance with the same hash", async () => {
		const mounted = mount();
		fireEvent.change(screen.getByPlaceholderText("Pick or type a category"), {
			target: { value: "old-target-draft" },
		});
		fireEvent.change(screen.getByPlaceholderText("Pick or type a tag"), {
			target: { value: "new-tag" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
		mounted.update({ ...copy, qbitInstanceId: 8 });
		expect(screen.getByPlaceholderText("Pick or type a tag")).toBeEnabled();
		expect(screen.getByPlaceholderText("Pick or type a category")).toHaveValue("existing");
		expect(
			screen.queryByText(/showing last-known tags until torrent data refreshes/i),
		).not.toBeInTheDocument();
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledWith(
			expect.objectContaining({ qbitInstanceId: 7 }),
		);
	});

	it("retains a rejected category edit as a draft and recovers after explicit retry", async () => {
		vi.mocked(quiApi.postQuiTorrentAction).mockRejectedValueOnce(
			new Error("Synthetic category rejection"),
		);
		mount();
		const input = screen.getByPlaceholderText("Pick or type a category");
		fireEvent.change(input, { target: { value: "edited-category" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText(/change was not confirmed/i);
		expect(input).toHaveValue("edited-category");
		expect(toast.success).not.toHaveBeenCalled();
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Category updated"));
		expect(quiApi.postQuiTorrentAction).toHaveBeenCalledTimes(2);
		expect(quiApi.postQuiTorrentAction).toHaveBeenLastCalledWith({
			quiInstanceId: "qui-1",
			qbitInstanceId: 7,
			hash: "a".repeat(40),
			action: "setCategory",
			payload: { category: "edited-category" },
		});
	});

	it("does not carry unsent tag or category drafts to another target", () => {
		const mounted = mount();
		fireEvent.change(screen.getByPlaceholderText("Pick or type a tag"), {
			target: { value: "old-tag-draft" },
		});
		fireEvent.change(screen.getByPlaceholderText("Pick or type a category"), {
			target: { value: "old-category-draft" },
		});
		mounted.update({ ...copy, quiInstanceId: "qui-other" });
		expect(screen.getByPlaceholderText("Pick or type a tag")).toHaveValue("");
		expect(screen.getByPlaceholderText("Pick or type a category")).toHaveValue("existing");
		expect(quiApi.postQuiTorrentAction).not.toHaveBeenCalled();
	});
});
