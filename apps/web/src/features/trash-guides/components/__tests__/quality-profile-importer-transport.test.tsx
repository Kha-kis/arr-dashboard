import type { CompleteQualityProfile, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QualityProfileImporter } from "../quality-profile-importer";
import { QualityProfileSelection } from "../wizard-steps/quality-profile-selection";

let client: QueryClient;
const services: ServiceInstanceSummary[] = ["a", "b"].map((id) => ({
	id,
	service: "radarr",
	label: `Radarr ${id}`,
	baseUrl: `http://${id}.invalid`,
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	tags: [],
}));
const imported: CompleteQualityProfile = {
	sourceInstanceId: "a",
	sourceInstanceLabel: "Radarr a",
	sourceProfileId: 7,
	sourceProfileName: "Source profile",
	sourceConnectionStateToken: "connection-a",
	importedAt: "2026-01-01T00:00:00.000Z",
	upgradeAllowed: true,
	cutoff: 4,
	cutoffQuality: { id: 4, name: "HDTV-720p", source: "television", resolution: 720 },
	items: [
		{
			id: 4,
			name: "HDTV-720p",
			allowed: true,
			quality: { id: 4, name: "HDTV-720p", source: "television", resolution: 720 },
		},
	],
	minFormatScore: 10,
	cutoffFormatScore: 100,
	minUpgradeFormatScore: 5,
	language: { id: 1, name: "English" },
	languages: [{ id: 1, name: "English", allowed: true }],
};
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function list(instance: string) {
	return {
		success: true,
		data: {
			profiles: [
				{
					id: instance === "a" ? 7 : 8,
					name: instance === "a" ? "Source profile" : "Other profile",
					upgradeAllowed: true,
					cutoff: 4,
					cutoffQuality: { id: 4, name: "HDTV-720p" },
					minFormatScore: 10,
					formatItemsCount: 1,
				},
			],
		},
	};
}
function mount(children: ReactNode) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
afterEach(async () => {
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("clone importer rendered transport", () => {
	it("is reachable from profile selection and imports the selected source/profile before explicit completion", async () => {
		const imports: RequestInit[] = [],
			gets: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === "/api/services") return response({ services });
				if (url === "/api/trash-guides/quality-profiles/RADARR")
					return response({
						profiles: [
							{
								trashId: "guide-a",
								name: "Guide profile",
								description: "",
								customFormatCount: 0,
								qualityCount: 1,
								cutoff: "HDTV-720p",
								upgradeAllowed: true,
							},
						],
						totalCount: 1,
						serviceType: "RADARR",
					});
				if (url === "/api/trash-guides/profile-clone/profiles/a") {
					gets.push(url);
					return response(list("a"));
				}
				if (url === "/api/trash-guides/profile-clone/import") {
					imports.push(init!);
					return response({ success: true, data: { profile: imported } });
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const onSelect = vi.fn();
		mount(<QualityProfileSelection serviceType="RADARR" onSelect={onSelect} />);
		fireEvent.click(await screen.findByText("Clone from Instance"));
		await screen.findByRole("option", { name: "Radarr a (radarr)" });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
		fireEvent.click(await screen.findByRole("button", { name: /Source profile/ }));
		fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
		await screen.findByText("Profile Imported Successfully");
		expect(gets[0]).toBe("/api/trash-guides/profile-clone/profiles/a");
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: '{"instanceId":"a","profileId":7}',
		});
		expect(onSelect).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Use This Profile" }));
		await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
		expect(onSelect.mock.calls[0]?.[0]).toMatchObject({
			name: "Source profile",
			description: "Cloned from Radarr a",
			cutoff: "HDTV-720p",
			customFormatCount: 0,
			qualityCount: 1,
			upgradeAllowed: true,
			language: "English",
		});
		expect(onSelect.mock.calls[0]?.[0].trashId).toMatch(/^cloned-a-7-/);
	});
	it("clears a reviewed profile and its selection when the source changes", async () => {
		const imports: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === "/api/services") return response({ services });
				if (url.endsWith("/profiles/a")) return response(list("a"));
				if (url.endsWith("/profiles/b")) return response(list("b"));
				if (url.endsWith("/import")) {
					imports.push(JSON.parse(String(init?.body)));
					return response({ success: true, data: { profile: imported } });
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const complete = vi.fn();
		mount(<QualityProfileImporter serviceType="RADARR" onImportComplete={complete} />);
		await screen.findByRole("option", { name: "Radarr a (radarr)" });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
		fireEvent.click(await screen.findByRole("button", { name: /Source profile/ }));
		fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
		await screen.findByText("Profile Imported Successfully");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
		await screen.findByRole("button", { name: /Other profile/ });
		expect(screen.queryByText("Profile Imported Successfully")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Use This Profile" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Import Profile" })).not.toBeInTheDocument();
		expect(imports).toEqual([{ instanceId: "a", profileId: 7 }]);
		expect(complete).not.toHaveBeenCalled();
	});
	it("does not restore the old review when an in-flight import resolves after changing sources", async () => {
		let release!: (r: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "/api/services") return response({ services });
				if (url.endsWith("/profiles/a")) return response(list("a"));
				if (url.endsWith("/profiles/b")) return response(list("b"));
				if (url.endsWith("/import")) return pending;
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const complete = vi.fn();
		mount(<QualityProfileImporter serviceType="RADARR" onImportComplete={complete} />);
		try {
			await screen.findByRole("option", { name: "Radarr a (radarr)" });
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
			fireEvent.click(await screen.findByRole("button", { name: /Source profile/ }));
			fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
			await screen.findByRole("button", { name: "Importing..." });
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
			await screen.findByRole("button", { name: /Other profile/ });
			await act(async () => {
				release(response({ success: true, data: { profile: imported } }));
				await pending;
			});
			await waitFor(() => expect(client.isMutating()).toBe(0));
			expect(screen.queryByRole("button", { name: "Use This Profile" })).not.toBeInTheDocument();
			expect(complete).not.toHaveBeenCalled();
		} finally {
			await act(async () => {
				release(response({ success: true, data: { profile: imported } }));
				await pending;
			});
		}
	});
	it("shows a rejected import as an actionable error without completion", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "/api/services") return response({ services });
				if (url.endsWith("/profiles/a")) return response(list("a"));
				if (url.endsWith("/import"))
					return response({ error: "Source changed; select the profile again" }, 409);
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const complete = vi.fn();
		mount(<QualityProfileImporter serviceType="RADARR" onImportComplete={complete} />);
		await screen.findByRole("option", { name: "Radarr a (radarr)" });
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
		fireEvent.click(await screen.findByRole("button", { name: /Source profile/ }));
		fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
		await screen.findByText("Source changed; select the profile again");
		expect(screen.getByRole("button", { name: "Import Profile" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Use This Profile" })).not.toBeInTheDocument();
		expect(complete).not.toHaveBeenCalled();
	});
	it.each([
		{ context: "another profile on the same source", nextProfileId: 9 },
		{ context: "source A to B to A with the same profile", nextProfileId: 7 },
		{ context: "explicit reselection of the same profile", nextProfileId: 7 },
	])(
		"discards superseded success for $context but accepts a deliberate current import",
		async ({ context, nextProfileId }) => {
			let release!: (r: Response) => void;
			const pending = new Promise<Response>((resolve) => {
				release = resolve;
			});
			const requests: unknown[] = [];
			const freshProfile: CompleteQualityProfile = {
				...imported,
				sourceProfileId: nextProfileId,
				sourceProfileName: "Fresh current review",
				sourceConnectionStateToken: "fresh-current-context",
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init?: RequestInit) => {
					if (url === "/api/services") return response({ services });
					if (url === "/api/trash-guides/profile-clone/profiles/a") {
						const body = list("a");
						body.data.profiles.push({
							id: 9,
							name: "Second source profile",
							upgradeAllowed: true,
							cutoff: 4,
							cutoffQuality: { id: 4, name: "HDTV-720p" },
							minFormatScore: 10,
							formatItemsCount: 1,
						});
						return response(body);
					}
					if (url === "/api/trash-guides/profile-clone/profiles/b") return response(list("b"));
					if (url === "/api/trash-guides/profile-clone/import") {
						requests.push(JSON.parse(String(init?.body)));
						return requests.length === 1
							? pending
							: response({ success: true, data: { profile: freshProfile } });
					}
					throw new Error(`Unexpected request ${url}`);
				}),
			);
			const complete = vi.fn(),
				close = vi.fn();
			mount(
				<QualityProfileImporter serviceType="RADARR" onImportComplete={complete} onClose={close} />,
			);
			try {
				await screen.findByRole("option", { name: "Radarr a (radarr)" });
				fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
				fireEvent.click(await screen.findByRole("button", { name: /^Source profile/ }));
				fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
				await screen.findByRole("button", { name: "Importing..." });
				expect(screen.getByRole("combobox")).toBeEnabled();
				if (context === "source A to B to A with the same profile") {
					fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
					await screen.findByRole("button", { name: /Other profile/ });
					fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
				}
				fireEvent.click(
					await screen.findByRole("button", {
						name: nextProfileId === 9 ? /^Second source profile/ : /^Source profile/,
					}),
				);
				expect(screen.getByRole("button", { name: "Importing..." })).toBeDisabled();
				fireEvent.click(screen.getByRole("button", { name: "Importing..." }));
				expect(requests).toEqual([{ instanceId: "a", profileId: 7 }]);
				await act(async () => {
					release(
						response({
							success: true,
							data: { profile: { ...imported, sourceProfileName: "Superseded review" } },
						}),
					);
					await pending;
				});
				await waitFor(() => expect(client.isMutating()).toBe(0));
				expect(screen.queryByRole("button", { name: "Use This Profile" })).not.toBeInTheDocument();
				expect(screen.queryByText("Superseded review")).not.toBeInTheDocument();
				expect(complete).not.toHaveBeenCalled();
				expect(close).not.toHaveBeenCalled();
				fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
				await screen.findByText("Fresh current review");
				expect(requests).toEqual([
					{ instanceId: "a", profileId: 7 },
					{ instanceId: "a", profileId: nextProfileId },
				]);
				expect(complete).not.toHaveBeenCalled();
				fireEvent.click(screen.getByRole("button", { name: "Use This Profile" }));
				expect(complete).toHaveBeenCalledTimes(1);
				expect(close).toHaveBeenCalledTimes(1);
				expect(complete.mock.calls[0]?.[0]).toMatchObject({
					sourceInstanceId: "a",
					sourceProfileId: nextProfileId,
					sourceProfileName: "Fresh current review",
					sourceConnectionStateToken: "fresh-current-context",
				});
			} finally {
				await act(async () => {
					release(response({ success: true, data: { profile: imported } }));
					await pending;
				});
			}
		},
	);
	it("discards stale errors, clears current feedback on selection and retries only the current source", async () => {
		let release!: (r: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const requests: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url === "/api/services") return response({ services });
				if (url === "/api/trash-guides/profile-clone/profiles/a") return response(list("a"));
				if (url === "/api/trash-guides/profile-clone/profiles/b") return response(list("b"));
				if (url === "/api/trash-guides/profile-clone/import") {
					requests.push(JSON.parse(String(init?.body)));
					if (requests.length === 1) return pending;
					if (requests.length === 2)
						return response({ error: "Current source refused; review selection" }, 409);
					return response({
						success: true,
						data: {
							profile: {
								...imported,
								sourceInstanceId: "b",
								sourceInstanceLabel: "Radarr b",
								sourceProfileId: 8,
								sourceProfileName: "Current source retry",
								sourceConnectionStateToken: "current-b-context",
							},
						},
					});
				}
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		const complete = vi.fn();
		mount(<QualityProfileImporter serviceType="RADARR" onImportComplete={complete} />);
		try {
			await screen.findByRole("option", { name: "Radarr a (radarr)" });
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
			fireEvent.click(await screen.findByRole("button", { name: /Source profile/ }));
			fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
			await screen.findByRole("button", { name: "Importing..." });
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
			fireEvent.click(await screen.findByRole("button", { name: /Other profile/ }));
			expect(screen.getByRole("button", { name: "Importing..." })).toBeDisabled();
			await act(async () => {
				release(response({ error: "Superseded source error" }, 409));
				await pending;
			});
			await waitFor(() => expect(client.isMutating()).toBe(0));
			expect(screen.queryByText("Superseded source error")).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Use This Profile" })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
			await screen.findByText("Current source refused; review selection");
			expect(complete).not.toHaveBeenCalled();
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
			await screen.findByRole("button", { name: /Source profile/ });
			expect(
				screen.queryByText("Current source refused; review selection"),
			).not.toBeInTheDocument();
			fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
			fireEvent.click(await screen.findByRole("button", { name: /Other profile/ }));
			fireEvent.click(screen.getByRole("button", { name: "Import Profile" }));
			await screen.findByText("Current source retry");
			expect(
				screen.queryByText("Current source refused; review selection"),
			).not.toBeInTheDocument();
			expect(complete).not.toHaveBeenCalled();
			expect(requests).toEqual([
				{ instanceId: "a", profileId: 7 },
				{ instanceId: "b", profileId: 8 },
				{ instanceId: "b", profileId: 8 },
			]);
			fireEvent.click(screen.getByRole("button", { name: "Use This Profile" }));
			expect(complete).toHaveBeenCalledTimes(1);
			expect(complete.mock.calls[0]?.[0]).toMatchObject({
				sourceInstanceId: "b",
				sourceProfileId: 8,
				sourceProfileName: "Current source retry",
				sourceConnectionStateToken: "current-b-context",
			});
		} finally {
			await act(async () => {
				release(response({ error: "Superseded source error" }, 409));
				await pending;
			});
		}
	});
});
