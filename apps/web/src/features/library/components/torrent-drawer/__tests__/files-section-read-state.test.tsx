import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../../contexts/IncognitoContext";
import type { SeriesTorrentCopy } from "../../../../../lib/api-client/qui";
import * as api from "../../../../../lib/api-client/qui";
import { quiKeys } from "../../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../../providers/color-theme-provider";
import { FilesSection } from "../files-section";

const copy: SeriesTorrentCopy = {
	quiInstanceId: "qui-1",
	qbitInstanceId: 7,
	infoHash: "a".repeat(40),
	name: "Example 1080p",
	role: "library",
	state: "seeding",
	progress: 1,
	torrentSizeBytes: "1024",
	ratio: 1,
	seedingTime: 0,
	numSeeds: 0,
	numLeechs: 0,
	dlSpeedBps: 0,
	upSpeedBps: 0,
	instanceName: "Example qBittorrent",
	tags: [],
	category: "",
	savePath: "/data",
	addedOn: 0,
	quiUnreachable: false,
	trackerHostnames: [],
	trackers: [],
	tracker: null,
	trackerHealth: null,
	peerSources: { dht: false, pex: false, lsd: false },
};
const file = { index: 0, name: "Example.mkv", size: 1024, priority: 1, progress: 1 };
let client: QueryClient;
beforeEach(() => {
	localStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.spyOn(api, "fetchQuiTorrentFiles").mockResolvedValue({ files: [file] });
	vi.spyOn(api, "fetchQuiFileMediaInfo").mockResolvedValue({
		mediaInfo: { fileIndex: 0, relativePath: file.name, streams: [] },
	});
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
});
function mount(selected = copy) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<QueryClientProvider client={client}>
					<FilesSection copy={selected} />
				</QueryClientProvider>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}
const key = quiKeys.torrentFiles.byHash("qui-1", 7, copy.infoHash);

describe("FilesSection read evidence", () => {
	it("reports a cold failure and recovers with only the existing file GET", async () => {
		vi.mocked(api.fetchQuiTorrentFiles).mockRejectedValueOnce(new Error("read unavailable"));
		mount();
		await screen.findByRole("alert");
		expect(screen.queryByText("No files")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /retry/i }));
		await screen.findByText(file.name);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(api.fetchQuiTorrentFiles).toHaveBeenCalledTimes(2);
		expect(api.fetchQuiTorrentFiles).toHaveBeenLastCalledWith({
			quiInstanceId: "qui-1",
			qbitInstanceId: 7,
			hash: copy.infoHash,
		});
		expect(api.fetchQuiFileMediaInfo).not.toHaveBeenCalled();
	});
	it("shows a confirmed empty list only after loading succeeds", async () => {
		let resolve!: (value: { files: (typeof file)[] }) => void;
		vi.mocked(api.fetchQuiTorrentFiles).mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		expect(screen.getByText(/Loading files/)).toBeInTheDocument();
		expect(screen.queryByText("No files")).not.toBeInTheDocument();
		await act(async () => resolve({ files: [] }));
		await screen.findByText("No files");
	});
	it.each([false, true])(
		"labels retained data on failed refresh (empty=%s), then clears the warning",
		async (empty) => {
			vi.mocked(api.fetchQuiTorrentFiles).mockResolvedValue({ files: empty ? [] : [file] });
			mount();
			await screen.findByText(empty ? "No files" : file.name);
			vi.mocked(api.fetchQuiTorrentFiles).mockRejectedValueOnce(new Error("refresh unavailable"));
			await act(async () => {
				await client.refetchQueries({ queryKey: key });
			});
			expect(await screen.findByRole("alert")).toHaveTextContent(/last-known/i);
			if (empty) expect(screen.queryByText("No files")).not.toBeInTheDocument();
			else expect(screen.getByText(file.name)).toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: /retry/i }));
			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			expect(api.fetchQuiTorrentFiles).toHaveBeenCalledTimes(3);
		},
	);
	it.each([{ quiUnreachable: true }, { quiInstanceId: null }, { qbitInstanceId: null }])(
		"never forces an unavailable target GET: %j",
		async (override) => {
			mount({ ...copy, ...override });
			expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i);
			expect(screen.queryByText("No files")).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
			expect(api.fetchQuiTorrentFiles).not.toHaveBeenCalled();
		},
	);
	it("retains a populated unavailable copy as last-known without offering a forced retry", () => {
		client.setQueryData(key, { files: [file] });
		mount({ ...copy, quiUnreachable: true });
		expect(screen.getByText(file.name)).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(/last-known/i);
		expect(screen.getByRole("button", { name: "Check quality" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Check quality" }));
		expect(api.fetchQuiFileMediaInfo).not.toHaveBeenCalled();
		expect(api.fetchQuiTorrentFiles).not.toHaveBeenCalled();
	});
	it("does not turn retained empty data into absence when the target becomes unreachable", () => {
		client.setQueryData(key, { files: [] });
		mount({ ...copy, quiUnreachable: true });
		expect(screen.getByRole("alert")).toHaveTextContent(/last-known/i);
		expect(screen.queryByText("No files")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
		expect(api.fetchQuiTorrentFiles).not.toHaveBeenCalled();
	});
	it("keeps quality reads lazy until a video is expanded", async () => {
		mount();
		await screen.findByText(file.name);
		expect(api.fetchQuiFileMediaInfo).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Check quality" }));
		await screen.findByText("No video stream detected");
		expect(api.fetchQuiFileMediaInfo).toHaveBeenCalledWith({
			quiInstanceId: "qui-1",
			qbitInstanceId: 7,
			hash: copy.infoHash,
			fileIndex: 0,
		});
	});
});
