import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";
import type { WebhookConfig } from "../../../lib/api-client/auto-tag-webhook";
import { autoTagKeys } from "../../../lib/query-keys";
import { ColorThemeProvider } from "../../../providers/color-theme-provider";
import { WebhookConfigPanel } from "./webhook-config-panel";

const secret = "synthetic-one-time-webhook-secret";
const configured: WebhookConfig = { secret: null, configured: true, freshlyGenerated: false };
const unconfigured: WebhookConfig = { secret: null, configured: false, freshlyGenerated: false };
const generated: WebhookConfig = { secret, configured: true, freshlyGenerated: true };
const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let client: QueryClient;
let configResponse: () => Promise<Response>;
let generationResponse: () => Promise<Response>;
let requests: Array<{ path: string; method: string }>;
let confirmDialog: ReturnType<typeof vi.spyOn>;
let clipboard: ReturnType<typeof vi.fn>;

beforeEach(() => {
	localStorage.clear();
	requests = [];
	configResponse = async () => response(unconfigured);
	generationResponse = async () => response(generated);
	confirmDialog = vi.spyOn(window, "confirm").mockReturnValue(true);
	clipboard = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: clipboard } });
	vi.stubGlobal("fetch", async (path: string, options?: RequestInit) => {
		const method = options?.method ?? "GET";
		requests.push({ path, method });
		if (path === "/api/auto-tag/webhook-config") return configResponse();
		if (path === "/api/auto-tag/webhook-config/regenerate") return generationResponse();
		if (path === "/api/auto-tag/webhook/install/status") {
			return response({
				instances: [
					{
						instanceId: "fixture-instance",
						label: "Fixture instance",
						service: "SONARR",
						installed: false,
						notificationId: null,
						error: null,
					},
				],
			});
		}
		throw new Error("Unexpected synthetic request");
	});
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false, gcTime: 300_000 },
			mutations: { retry: false },
		},
	});
});

afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mount() {
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<WebhookConfigPanel />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

const credential = () => screen.getByLabelText(/Authorization header/) as HTMLInputElement;
const mutationRequests = () => requests.filter((request) => request.method === "POST");
const installButton = () => screen.getByRole("button", { name: /Install \/ Update/ });
const secretCopyButton = () =>
	screen.getByRole("button", { name: /^(Copy secret|Rotate to view a new secret)$/ });
const chooseInstance = () =>
	fireEvent.click(screen.getByRole("checkbox", { name: /Fixture instance/ }));

describe("real webhook credential panel", () => {
	it("pending replacement cannot revive old plaintext on a fresh-cache remount", async () => {
		const first = mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		const initialReads = requests.filter(
			(request) => request.path === "/api/auto-tag/webhook-config",
		).length;
		let completeReplacement!: (value: Response) => void;
		let plaintextClearedAtDispatch = false;
		const pending = new Promise<Response>((resolve) => {
			completeReplacement = resolve;
		});
		generationResponse = () => {
			plaintextClearedAtDispatch =
				client.getQueryData<WebhookConfig>(autoTagKeys.webhookConfig)?.secret === null;
			return pending;
		};
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Rotate secret" })).toBeDisabled(),
		);
		first.unmount();
		mount();
		await screen.findByRole("button", { name: "Rotate secret" });
		expect(credential().value === secret).toBe(false);
		expect(secretCopyButton()).toBeDisabled();
		chooseInstance();
		expect(installButton()).toBeDisabled();
		expect(client.getQueryData<WebhookConfig>(autoTagKeys.webhookConfig)?.configured).toBe(true);
		expect(plaintextClearedAtDispatch).toBe(true);
		expect(
			requests.filter((request) => request.path === "/api/auto-tag/webhook-config"),
		).toHaveLength(initialReads);
		expect(mutationRequests()).toHaveLength(2);
		const replacementSecret = "synthetic-confirmed-replacement-secret";
		await act(async () => {
			completeReplacement(response({ ...generated, secret: replacementSecret }));
		});
		await waitFor(() => expect(credential().value === replacementSecret).toBe(true));
		expect(secretCopyButton()).toBeEnabled();
		expect(installButton()).toBeEnabled();
		expect(mutationRequests()).toHaveLength(2);
	});

	it("lost replacement acknowledgment cannot revive old plaintext or replay POST after remount", async () => {
		const first = mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		const initialReads = requests.filter(
			(request) => request.path === "/api/auto-tag/webhook-config",
		).length;
		generationResponse = async () => {
			throw new Error("Synthetic replacement acknowledgment lost");
		};
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await screen.findByRole("alert");
		first.unmount();
		mount();
		const action = await screen.findByRole("button", { name: "Rotate secret" });
		expect(credential().value === secret).toBe(false);
		expect(secretCopyButton()).toBeDisabled();
		chooseInstance();
		expect(installButton()).toBeDisabled();
		expect(client.getQueryData<WebhookConfig>(autoTagKeys.webhookConfig)?.configured).toBe(true);
		expect(
			requests.filter((request) => request.path === "/api/auto-tag/webhook-config"),
		).toHaveLength(initialReads);
		expect(mutationRequests()).toHaveLength(2);
		expect(confirmDialog).toHaveBeenCalledTimes(2);
		confirmDialog.mockReturnValue(false);
		fireEvent.click(action);
		expect(mutationRequests()).toHaveLength(2);
		expect(secretCopyButton()).toBeDisabled();
		confirmDialog.mockReturnValue(true);
		const replacementSecret = "synthetic-confirmed-retry-secret";
		generationResponse = async () => response({ ...generated, secret: replacementSecret });
		fireEvent.click(action);
		await waitFor(() => expect(credential().value === replacementSecret).toBe(true));
		expect(confirmDialog).toHaveBeenCalledTimes(4);
		expect(mutationRequests()).toHaveLength(3);
		expect(installButton()).toBeEnabled();
	});

	it("cancelled replacement preserves the current secret across a fresh-cache remount", async () => {
		const first = mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		confirmDialog.mockReturnValue(false);
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		first.unmount();
		mount();
		await screen.findByRole("button", { name: "Rotate secret" });
		expect(credential().value === secret).toBe(true);
		expect(secretCopyButton()).toBeEnabled();
		chooseInstance();
		expect(installButton()).toBeEnabled();
		expect(mutationRequests()).toHaveLength(1);
	});
	it("waits for confirmed unconfigured status before offering Generate", async () => {
		mount();
		const action = await screen.findByRole("button", { name: "Generate secret" });
		await waitFor(() => expect(action).toBeEnabled());
		expect(credential().value).toBe("");
		chooseInstance();
		expect(installButton()).toBeDisabled();
		expect(mutationRequests()).toEqual([]);
	});

	it("only generates after explicit click and honest replacement confirmation", async () => {
		mount();
		const action = await screen.findByRole("button", { name: "Generate secret" });
		chooseInstance();
		expect(installButton()).toBeDisabled();
		fireEvent.click(action);
		await waitFor(() => expect(credential().value === secret).toBe(true));
		expect(confirmDialog).toHaveBeenCalledWith(expect.stringMatching(/another tab/));
		expect(confirmDialog).toHaveBeenCalledWith(expect.stringMatching(/replace/i));
		expect(mutationRequests()).toEqual([
			{ path: "/api/auto-tag/webhook-config/regenerate", method: "POST" },
		]);
		expect(installButton()).toBeEnabled();
		expect(screen.getByRole("button", { name: "Rotate secret" })).toBeEnabled();
	});

	it("cancelling Generate performs no credential or installation mutation", async () => {
		confirmDialog.mockReturnValue(false);
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		expect(confirmDialog).toHaveBeenCalledOnce();
		expect(credential().value).toBe("");
		expect(mutationRequests()).toEqual([]);
	});

	it.each([false, true])(
		"configured rotation requires confirmation (accepted=%s)",
		async (accepted) => {
			configResponse = async () => response(configured);
			confirmDialog.mockReturnValue(accepted);
			mount();
			const action = await screen.findByRole("button", { name: "Rotate secret" });
			await waitFor(() => expect(action).toBeEnabled());
			expect(credential().value).toMatch(/secret hidden/);
			fireEvent.click(action);
			expect(confirmDialog).toHaveBeenCalledWith(
				"Rotating the secret invalidates any existing Sonarr/Radarr Connect webhook using the old value. You'll need to update those settings. Continue?",
			);
			if (accepted) {
				await waitFor(() => expect(credential().value === secret).toBe(true));
				expect(mutationRequests()).toHaveLength(1);
			} else {
				expect(credential().value).toMatch(/secret hidden/);
				expect(mutationRequests()).toEqual([]);
			}
		},
	);

	it("loading cannot authorize credential generation", async () => {
		configResponse = () => new Promise(() => {});
		mount();
		expect(credential().value).toBe("Loading…");
		const action = screen.getByRole("button", { name: /^(Manage|Generate|Rotate) secret$/ });
		expect(action).toBeDisabled();
		fireEvent.click(action);
		expect(confirmDialog).not.toHaveBeenCalled();
		expect(mutationRequests()).toEqual([]);
	});

	it("initial status failure shows unavailable state and prevents mutations", async () => {
		configResponse = async () => response({ error: "Synthetic private diagnostic" }, 500);
		mount();
		await screen.findByRole("alert");
		expect(
			screen.getByRole("button", { name: /^(Manage|Generate|Rotate) secret$/ }),
		).toBeDisabled();
		expect(credential().value).toMatch(/unavailable/i);
		expect(screen.queryByText(/Synthetic private diagnostic/)).not.toBeInTheDocument();
		expect(mutationRequests()).toEqual([]);
	});

	it("cached status after failed refetch authorizes neither rotation, copying nor install", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		chooseInstance();
		expect(installButton()).toBeEnabled();
		configResponse = async () => response({ error: "Synthetic refetch failure" }, 500);
		await act(async () => {
			await client.refetchQueries({ queryKey: autoTagKeys.webhookConfig });
		});
		await screen.findByRole("alert");
		expect(
			screen.getByRole("button", { name: /^(Manage|Generate|Rotate) secret$/ }),
		).toBeDisabled();
		expect(credential().value).toMatch(/unavailable/i);
		expect(secretCopyButton()).toBeDisabled();
		expect(installButton()).toBeDisabled();
		expect(mutationRequests()).toHaveLength(1);
	});

	it("refreshing cached status temporarily disables credential actions", async () => {
		configResponse = async () => response(configured);
		mount();
		const action = await screen.findByRole("button", { name: "Rotate secret" });
		await waitFor(() => expect(action).toBeEnabled());
		configResponse = () => new Promise(() => {});
		await act(async () => {
			void client.refetchQueries({ queryKey: autoTagKeys.webhookConfig });
		});
		await waitFor(() => expect(action).toBeDisabled());
		fireEvent.click(action);
		expect(confirmDialog).not.toHaveBeenCalled();
		expect(mutationRequests()).toEqual([]);
	});

	it("failed generation is caught, remains unconfigured, and does not install", async () => {
		generationResponse = async () => response({ error: "Synthetic private diagnostic" }, 500);
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/could not.*secret/i);
		expect(alert).not.toHaveTextContent(/Synthetic private diagnostic/);
		expect(credential().value).toBe("");
		expect(screen.getByRole("button", { name: "Generate secret" })).toBeEnabled();
		chooseInstance();
		expect(installButton()).toBeDisabled();
		expect(mutationRequests()).toHaveLength(1);
	});

	it("failed rotation retains configured status without exposing an old secret to install", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		generationResponse = async () => response({ error: "Synthetic persistence failure" }, 500);
		chooseInstance();
		fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
		await screen.findByRole("alert");
		expect(screen.getByRole("button", { name: "Rotate secret" })).toBeEnabled();
		expect(credential().value === secret).toBe(false);
		expect(secretCopyButton()).toBeDisabled();
		expect(installButton()).toBeDisabled();
		expect(mutationRequests()).toHaveLength(2);
	});

	it("pending rotation removes stale plaintext copy and installation authority", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		chooseInstance();
		expect(installButton()).toBeEnabled();
		generationResponse = () => new Promise(() => {});
		const action = screen.getByRole("button", { name: "Rotate secret" });
		fireEvent.click(action);
		await waitFor(() => expect(action).toBeDisabled());
		expect(credential().value === secret).toBe(false);
		expect(secretCopyButton()).toBeDisabled();
		expect(installButton()).toBeDisabled();
		fireEvent.click(action);
		expect(mutationRequests()).toHaveLength(2);
	});

	it("pending generation prevents repeated credential clicks and install", async () => {
		generationResponse = () => new Promise(() => {});
		mount();
		const action = await screen.findByRole("button", { name: "Generate secret" });
		fireEvent.click(action);
		await waitFor(() => expect(action).toBeDisabled());
		fireEvent.click(action);
		chooseInstance();
		expect(installButton()).toBeDisabled();
		expect(mutationRequests()).toHaveLength(1);
	});

	it("incognito masks a generated credential and blocks copying", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value).toBe("•".repeat(43)));
		const copy = screen.getByTitle("Disable hide-sensitive-data to copy");
		expect(copy).toBeDisabled();
		fireEvent.click(copy);
		expect(clipboard).not.toHaveBeenCalled();
		expect(mutationRequests()).toHaveLength(1);
	});

	it("explicit copying is available for a visible newly generated credential", async () => {
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Generate secret" }));
		await waitFor(() => expect(credential().value === secret).toBe(true));
		fireEvent.click(screen.getByTitle("Copy secret"));
		await waitFor(() => expect(clipboard).toHaveBeenCalledWith(secret));
		expect(mutationRequests()).toHaveLength(1);
	});
});
