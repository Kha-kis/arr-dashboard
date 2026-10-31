import { type CrossSeedDiscoveryItem, QUI_BULK_HASH_CAP } from "@arr/shared";
import { QueryClient, QueryClientProvider, useIsMutating } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import * as quiApi from "../../../../lib/api-client/qui";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { CrossSeedBulkToolbar } from "../cross-seed-bulk-toolbar";

vi.mock("../../../../lib/api-client/qui");
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const clients: QueryClient[] = [];
const dispatched = vi.mocked(quiApi.postQuiBulkAction);
const acknowledged = { status: "success", logRowCount: 1 } as const;

function item(id: number, qbitInstanceId = 11): CrossSeedDiscoveryItem {
	return {
		libraryCacheId: `library-${id}`,
		arrInstanceId: "arr-1",
		arrInstanceLabel: "Synthetic source",
		arrService: "sonarr",
		itemType: "series",
		arrItemId: id,
		title: "Synthetic item",
		year: null,
		primary: {
			hash: id.toString(16).padStart(40, "0"),
			qbitInstanceId,
			qbitInstanceName: `Synthetic qBit ${qbitInstanceId}`,
			state: "uploading",
			ratio: 1,
			tracker: null,
		},
		siblings: [],
	};
}

function BatchProbe() {
	return <output>Pending groups: {useIsMutating()}</output>;
}

function mount(selectedItems: CrossSeedDiscoveryItem[], onClear = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	const ui = (items: CrossSeedDiscoveryItem[]) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<CrossSeedBulkToolbar quiInstanceId="qui-1" selectedItems={items} onClear={onClear} />
					<BatchProbe />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const rendered = render(ui(selectedItems));
	return {
		onClear,
		client,
		update: (items: CrossSeedDiscoveryItem[]) => rendered.rerender(ui(items)),
	};
}

function confirm(label = "Pause") {
	fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label} \\d+ selected`) }));
	const dialog = screen.getByRole("dialog");
	const button = within(dialog).getByRole("button", { name: `Confirm ${label.toLowerCase()}` });
	return { dialog, button };
}

function deferred() {
	let resolve!: (value: typeof acknowledged) => void;
	const promise = new Promise<typeof acknowledged>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.resetAllMocks();
	dispatched.mockResolvedValue(acknowledged);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("Cross-seed bulk toolbar with real mutation hooks", () => {
	it("requires confirmation and cancellation never dispatches", () => {
		mount([item(1)]);
		confirm();
		expect(dispatched).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(dispatched).not.toHaveBeenCalled();
	});

	it.each(["Pause", "Resume", "Recheck", "Reannounce"])(
		"groups only primary hashes by instance for %s",
		async (label) => {
			const first = item(1);
			first.siblings = [
				{
					hash: "f".repeat(40),
					name: "Synthetic sibling",
					instanceId: 99,
					instanceName: "Synthetic sibling source",
					state: "uploading",
					progress: 1,
					size: 1,
					category: "",
					savePath: "/synthetic",
					contentPath: "/synthetic/item",
					tracker: "synthetic.invalid",
					matchType: "release",
					tags: "",
				},
			];
			const missing = { ...item(4), primary: null };
			const { onClear } = mount([first, item(2), item(3, 22), missing]);
			fireEvent.click(confirm(label).button);
			await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
			expect(dispatched.mock.calls.map(([args]) => args)).toEqual([
				{
					quiInstanceId: "qui-1",
					qbitInstanceId: 11,
					action: label.toLowerCase(),
					hashes: [
						"0000000000000000000000000000000000000001",
						"0000000000000000000000000000000000000002",
					],
				},
				{
					quiInstanceId: "qui-1",
					qbitInstanceId: 22,
					action: label.toLowerCase(),
					hashes: ["0000000000000000000000000000000000000003"],
				},
			]);
			expect(toast.success).toHaveBeenCalledWith(`${label} sent to 3 torrents in qui`);
		},
	);

	it("disables every action when no selected item has a primary", () => {
		mount([{ ...item(1), primary: null }]);
		for (const button of screen.getAllByRole("button", { name: /selected torrents$/ })) {
			expect(button).toBeDisabled();
			fireEvent.click(button);
		}
		expect(dispatched).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("enforces the cap per instance rather than across the whole selection", async () => {
		const selected = Array.from({ length: QUI_BULK_HASH_CAP + 2 }, (_, i) =>
			item(i + 1, i % 2 ? 22 : 11),
		);
		const { onClear } = mount(selected);
		fireEvent.click(confirm().button);
		await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
		expect(dispatched).toHaveBeenCalledTimes(2);
		expect(dispatched.mock.calls.map(([args]) => args.hashes.length)).toEqual([251, 251]);
	});

	it("accepts exactly one per-instance cap but refuses a larger group", async () => {
		const selected = Array.from({ length: QUI_BULK_HASH_CAP }, (_, i) => item(i + 1));
		const mounted = mount(selected);
		expect(screen.getByRole("button", { name: /^Pause / })).toBeEnabled();
		mounted.update([...selected, item(QUI_BULK_HASH_CAP + 1)]);
		for (const button of screen.getAllByRole("button", { name: /selected torrents$/ }))
			expect(button).toBeDisabled();
		expect(dispatched).not.toHaveBeenCalled();
	});

	it("rechecks the cap if the selection grows while confirmation is open", async () => {
		const mounted = mount([item(1)]);
		confirm();
		mounted.update(Array.from({ length: QUI_BULK_HASH_CAP + 1 }, (_, i) => item(i + 1)));
		fireEvent.click(screen.getByRole("button", { name: "Confirm pause" }));
		await act(async () => {});
		expect(dispatched).not.toHaveBeenCalled();
	});

	it("reports mixed outcomes without claiming all succeeded or replaying a failed group", async () => {
		dispatched.mockImplementation(async (args) => {
			if (args.qbitInstanceId === 22) throw new Error("Synthetic uncertain response");
			return acknowledged;
		});
		const { onClear } = mount([item(1), item(2, 22)]);
		fireEvent.click(confirm().button);
		await waitFor(() =>
			expect(toast.warning).toHaveBeenCalledWith(
				"Pause: 1 succeeded, 1 failed (see My Actions for details)",
			),
		);
		expect(onClear).toHaveBeenCalledTimes(1);
		expect(toast.success).not.toHaveBeenCalled();
		expect(dispatched).toHaveBeenCalledTimes(2);
	});

	it("retains the selection after complete failure and retries only after new confirmation", async () => {
		dispatched.mockRejectedValueOnce(new Error("Synthetic unavailable response"));
		const { onClear } = mount([item(1)]);
		fireEvent.click(confirm().button);
		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(onClear).not.toHaveBeenCalled();
		expect(dispatched).toHaveBeenCalledTimes(1);
		expect(toast.success).not.toHaveBeenCalled();
		fireEvent.click(confirm().button);
		await waitFor(() => expect(onClear).toHaveBeenCalledTimes(1));
		expect(dispatched).toHaveBeenCalledTimes(2);
	});

	it("keeps all controls locked until the earlier group settles after the latest group", async () => {
		const earlier = deferred();
		dispatched.mockImplementation((args) =>
			args.qbitInstanceId === 11 ? earlier.promise : Promise.resolve(acknowledged),
		);
		const { onClear } = mount([item(1), item(2, 22)]);
		fireEvent.click(confirm().button);
		try {
			await screen.findByText("Pending groups: 1");
			expect(dispatched).toHaveBeenCalledTimes(2);
			expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
			expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
			for (const button of screen.getAllByRole("button", { name: /selected torrents$/ }))
				expect(button).toBeDisabled();
			expect(onClear).not.toHaveBeenCalled();
			expect(toast.success).not.toHaveBeenCalled();
		} finally {
			await act(async () => earlier.resolve(acknowledged));
			await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		}
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it("does not dispatch a second batch from two confirmations in the same event turn", async () => {
		const held = deferred();
		dispatched.mockReturnValue(held.promise);
		mount([item(1), item(2, 22)]);
		const { button } = confirm();
		try {
			act(() => {
				button.click();
				button.click();
			});
			await waitFor(() => expect(dispatched).toHaveBeenCalledTimes(2));
		} finally {
			await act(async () => held.resolve(acknowledged));
			await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		}
		expect(dispatched).toHaveBeenCalledTimes(2);
	});
});
