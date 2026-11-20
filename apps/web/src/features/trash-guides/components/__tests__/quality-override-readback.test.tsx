import type { CustomQualityConfig, TrashTemplate } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { InstanceQualityOverrideModal } from "../instance-quality-override-modal";
import { InstanceOverridesPanel } from "../instance-overrides-panel";

const defaultQuality: CustomQualityConfig = {
	useCustomQualities: true,
	items: [
		{
			type: "quality",
			item: { id: "q1", name: "Synthetic HD", allowed: true, source: "web", resolution: 1080 },
		},
	],
	cutoffId: "q1",
};
const savedQuality: CustomQualityConfig = {
	...defaultQuality,
	origin: "instance",
	items: [
		{
			type: "quality",
			item: { id: "q1", name: "Confirmed HD", allowed: false, source: "web", resolution: 1080 },
		},
	],
};
const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const readback = (
	instanceId = "instance-a",
	qualityConfigOverride?: CustomQualityConfig,
	templateId = "template-a",
) => ({
	templateId,
	instanceId,
	overrides: {
		instanceId,
		cfScoreOverrides: { "cf-a": 123 },
		...(qualityConfigOverride ? { qualityConfigOverride } : {}),
		lastModifiedAt: "2026-11-02T00:00:00.000Z",
		lastModifiedBy: "synthetic-user",
	},
});
const clients: QueryClient[] = [],
	releases: Array<() => void> = [],
	issued = new Set<Promise<Response>>();
function hold(body: unknown) {
	let resolve!: (r: Response) => void;
	const promise = new Promise<Response>((r) => (resolve = r));
	releases.push(() => resolve(response(body)));
	return { promise, resolve };
}
function transport(
	handler: (
		instanceId: string,
		method: string,
		body: unknown,
		templateId: string,
	) => Response | Promise<Response>,
) {
	vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
		const match = /^\/api\/trash-guides\/templates\/([^/]+)\/instance-overrides\/([^/]+)$/.exec(
			url,
		);
		if (!match || !["GET", "PUT"].includes(init?.method ?? "GET"))
			throw Error("Unexpected synthetic transport");
		const p = Promise.resolve(
			handler(
				match[2]!,
				init?.method ?? "GET",
				init?.body ? JSON.parse(String(init.body)) : undefined,
				match[1]!,
			),
		);
		issued.add(p);
		void p.then(
			() => issued.delete(p),
			() => issued.delete(p),
		);
		return p;
	});
}
function wrap(node: React.ReactNode, client: QueryClient) {
	return (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{node}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}
function mount(
	instanceId = "instance-a",
	onSaved = vi.fn(),
	templateId = "template-a",
	strict = false,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	const node = (id: string, tid: string) => {
		const wrapped = wrap(
			<InstanceQualityOverrideModal
				open
				onClose={() => {}}
				onSaved={onSaved}
				templateId={tid}
				templateName="Synthetic Template"
				instanceId={id}
				instanceLabel={id}
				serviceType="RADARR"
				templateDefaultConfig={defaultQuality}
			/>,
			client,
		);
		return strict ? <StrictMode>{wrapped}</StrictMode> : wrapped;
	};
	const view = render(node(instanceId, templateId));
	return {
		...view,
		client,
		onSaved,
		target: (id: string, tid = templateId) => view.rerender(node(id, tid)),
	};
}
async function ready() {
	await screen.findByRole("button", { name: /Use Template Default/ });
	await waitFor(() =>
		expect(screen.queryByText("Loading configuration...")).not.toBeInTheDocument(),
	);
}
async function save() {
	fireEvent.click(screen.getByRole("button", { name: /Customize for This Instance/ }));
	fireEvent.click(screen.getByTitle("Enabled - click to disable"));
	fireEvent.click(screen.getByRole("button", { name: "Save Override" }));
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.allSettled([...issued]);
	cleanup();
	for (const c of clients.splice(0)) {
		await c.cancelQueries();
		c.clear();
	}
	expect(issued.size).toBe(0);
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("quality override confirmed initial read", () => {
	// Break caught: effect cleanup leaves initial-read admission latched during Strict Mode replay.
	it("recovers an initial read after strict effect replay without admitting a write", async () => {
		let available = false,
			puts = 0;
		transport((_id, method) => {
			if (method === "PUT") {
				puts++;
				return response({ success: true });
			}
			return available
				? response(readback())
				: response({ message: "Synthetic initial unavailable" }, 503);
		});
		const { onSaved } = mount("instance-a", vi.fn(), "template-a", true);
		await screen.findByText(/current quality settings are unknown/i);
		expect(
			screen.queryByRole("button", { name: /Customize for This Instance/ }),
		).not.toBeInTheDocument();
		available = true;
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await ready();
		expect(puts).toBe(0);
		expect(onSaved).not.toHaveBeenCalled();
	});
	// Break caught: a failed or wrong-scope GET exposes editable fallback/default content.
	it.each(["http", "template", "instance", "nested-instance"])(
		"keeps %s initial read failure unknown and blocks editing until GET-only recovery",
		async (failure) => {
			let gets = 0,
				puts = 0;
			transport((_id, method) => {
				if (method === "PUT") {
					puts++;
					return response({ success: true });
				}
				if (++gets > 1) return response(readback());
				if (failure === "http") return response({ message: "Synthetic initial unavailable" }, 503);
				const wrong = readback("instance-a", savedQuality);
				if (failure === "template") wrong.templateId = "template-b";
				if (failure === "instance") wrong.instanceId = "instance-b";
				if (failure === "nested-instance") wrong.overrides.instanceId = "instance-b";
				return response(wrong);
			});
			const { onSaved } = mount();
			await waitFor(() =>
				expect(screen.queryByText("Loading configuration...")).not.toBeInTheDocument(),
			);
			expect(
				screen.queryByRole("button", { name: /Use Template Default/ }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /Customize for This Instance/ }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /Save Override|Reset to Template Default/ }),
			).not.toBeInTheDocument();
			expect(screen.queryByTitle("Enabled - click to disable")).not.toBeInTheDocument();
			expect(screen.queryByText("Has Override")).not.toBeInTheDocument();
			await screen.findByText(/current quality settings are unknown/i);
			expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
			const retry = screen.getByRole("button", { name: "Retry loading" });
			expect(retry).toBeEnabled();
			fireEvent.click(retry);
			await ready();
			expect(gets).toBe(2);
			expect(puts).toBe(0);
			expect(onSaved).not.toHaveBeenCalled();
			await save();
			await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
			expect(puts).toBe(1);
		},
	);
	// Break caught: retry writes, silently enables default editing while pending, or swallows a second failure.
	it("keeps repeated and pending initial retries read-only until a valid selected response", async () => {
		const held = hold(readback("instance-a", savedQuality));
		let gets = 0,
			puts = 0;
		transport((_id, method) => {
			if (method === "PUT") {
				puts++;
				return response({ success: true });
			}
			return ++gets <= 2
				? response({ message: "Synthetic initial unavailable" }, 503)
				: held.promise;
		});
		const { onSaved } = mount();
		await waitFor(() =>
			expect(screen.queryByText("Loading configuration...")).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByRole("button", { name: /Customize for This Instance/ }),
		).not.toBeInTheDocument();
		await screen.findByText(/current quality settings are unknown/i);
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await waitFor(() => expect(gets).toBe(2));
		await screen.findByText(/current quality settings are unknown/i);
		fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
		await waitFor(() => expect(gets).toBe(3));
		expect(screen.getByText("Loading configuration...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Retry loading" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
		expect(
			screen.queryByRole("button", {
				name: /Save Override|Reset to Template Default|Customize for This Instance|Use Template Default/,
			}),
		).not.toBeInTheDocument();
		expect(puts).toBe(0);
		expect(onSaved).not.toHaveBeenCalled();
		await act(async () => held.resolve(response(readback("instance-a", savedQuality))));
		await screen.findByText("Has Override");
		expect(screen.getByRole("button", { name: "Reset to Template Default" })).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Retry loading" })).not.toBeInTheDocument();
		expect(puts).toBe(0);
		expect(onSaved).not.toHaveBeenCalled();
	});
	// Break caught: a retry from a retired session confirms/overwrites a new target or calls its parent.
	it.each(["target", "unmount"])(
		"ignores late initial retry completion after %s",
		async (change) => {
			const held = hold(readback("instance-a", savedQuality));
			let getsA = 0,
				puts = 0;
			transport((id, method) => {
				if (method === "PUT") {
					puts++;
					return response({ success: true });
				}
				if (id === "instance-b") return response(readback("instance-b"));
				return ++getsA === 1
					? response({ message: "Synthetic initial unavailable" }, 503)
					: held.promise;
			});
			const view = mount();
			await waitFor(() =>
				expect(screen.queryByText("Loading configuration...")).not.toBeInTheDocument(),
			);
			expect(
				screen.queryByRole("button", { name: /Customize for This Instance/ }),
			).not.toBeInTheDocument();
			await screen.findByText(/current quality settings are unknown/i);
			fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
			await waitFor(() => expect(getsA).toBe(2));
			if (change === "target") {
				view.target("instance-b");
				await ready();
			} else view.unmount();
			await act(async () => held.resolve(response(readback("instance-a", savedQuality))));
			if (change === "target") {
				expect(
					screen.getByRole("dialog", { name: "Quality Settings for instance-b" }),
				).toBeInTheDocument();
				expect(screen.queryByText("Has Override")).not.toBeInTheDocument();
				expect(screen.getByRole("button", { name: /Use Template Default/ })).toBeInTheDocument();
			} else expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(puts).toBe(0);
			expect(view.onSaved).not.toHaveBeenCalled();
		},
	);
});

describe("quality override confirmed selected-link readback", () => {
	it("keeps a pending confirmation across a harmless parent rerender and uses its latest callback", async () => {
		const server = readback("instance-a", savedQuality),
			held = hold(server);
		let gets = 0;
		transport((_id, method) =>
			method === "PUT"
				? response({ success: true })
				: ++gets === 1
					? response(readback())
					: held.promise,
		);
		const view = mount(),
			latest = vi.fn();
		await ready();
		await save();
		await waitFor(() => expect(gets).toBe(2));
		view.rerender(
			wrap(
				<InstanceQualityOverrideModal
					open
					onClose={() => {}}
					onSaved={latest}
					templateId="template-a"
					templateName="Synthetic Template"
					instanceId="instance-a"
					instanceLabel="instance-a"
					serviceType="RADARR"
					templateDefaultConfig={{ ...defaultQuality }}
				/>,
				view.client,
			),
		);
		expect.soft(gets).toBe(2);
		await act(async () => held.resolve(response(server)));
		await waitFor(() => expect(latest).toHaveBeenCalledWith(server));
		expect(view.onSaved).not.toHaveBeenCalled();
	});
	// Break caught: ack/local draft is passed as confirmed or shared invalidation/readback is omitted.
	it.each(["save", "reset"])(
		"%s awaits the actual selected GET and delivers complete server readback",
		async (operation) => {
			const server = readback("instance-a", operation === "save" ? savedQuality : undefined),
				pending = hold(server);
			let gets = 0,
				puts = 0;
			transport((_id, method, body) => {
				if (method === "PUT") {
					puts++;
					expect(body).toMatchObject({
						qualityConfigOverride:
							operation === "reset" ? null : { useCustomQualities: true, origin: "instance" },
					});
					return response({ success: true, overrides: {} });
				}
				return ++gets === 1
					? response(readback("instance-a", operation === "reset" ? savedQuality : undefined))
					: pending.promise;
			});
			const { client, onSaved } = mount();
			const key = ["trash-guides", "deployment", "preview", "template-a", "instance-a"],
				otherKey = ["trash-guides", "deployment", "preview", "template-a", "instance-b"];
			client.setQueryData(key, { token: "old" });
			client.setQueryData(otherKey, { token: "other" });
			await ready();
			if (operation === "save") await save();
			else fireEvent.click(screen.getByRole("button", { name: "Reset to Template Default" }));
			try {
				await waitFor(() => expect(gets).toBe(2));
				expect(puts).toBe(1);
				expect(onSaved).not.toHaveBeenCalled();
				expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
				expect(client.getQueryState(key)?.isInvalidated).toBe(true);
				expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
				await act(async () => pending.resolve(response(server)));
				await waitFor(() => expect(onSaved).toHaveBeenCalledWith(server));
				expect(puts).toBe(1);
			} finally {
				pending.resolve(response(server));
			}
		},
	);
	// Break caught: failed confirmation repeats the PUT, discards draft, or claims success/default early.
	it.each(["save", "reset"])(
		"%s keeps unconfirmed state and retries only GET after readback failure",
		async (operation) => {
			let gets = 0,
				puts = 0;
			transport((_id, method) => {
				if (method === "PUT") {
					puts++;
					return response({ success: true });
				}
				gets++;
				return gets === 1
					? response(readback("instance-a", operation === "reset" ? savedQuality : undefined))
					: gets === 2
						? response({ message: "Synthetic readback unavailable" }, 503)
						: response(readback("instance-a", operation === "save" ? savedQuality : undefined));
			});
			const { onSaved } = mount();
			await ready();
			if (operation === "save") await save();
			else fireEvent.click(screen.getByRole("button", { name: "Reset to Template Default" }));
			await screen.findByText(/saved.*not.*confirmed/i);
			expect(onSaved).not.toHaveBeenCalled();
			expect(puts).toBe(1);
			if (operation === "save") {
				expect(screen.getByTitle("Disabled - click to enable")).not.toBeChecked();
				expect(screen.getByRole("button", { name: "Save Override" })).toBeDisabled();
			} else expect(screen.getByText("Has Override")).toBeInTheDocument();
			const retry = screen.getByRole("button", { name: "Retry readback" });
			expect(retry).toBeEnabled();
			await act(async () => {
				(retry as HTMLButtonElement).click();
			});
			await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
			expect(puts).toBe(1);
			expect(gets).toBe(3);
		},
	);
	it.each(["template", "instance", "nested-instance"])(
		"refuses mismatched %s readback identity without confirming",
		async (mismatch) => {
			let gets = 0;
			transport((_id, method) => {
				if (method === "PUT") return response({ success: true });
				if (++gets === 1) return response(readback());
				const body = readback("instance-a", savedQuality);
				if (mismatch === "template") body.templateId = "template-b";
				if (mismatch === "instance") body.instanceId = "instance-b";
				if (mismatch === "nested-instance") body.overrides.instanceId = "instance-b";
				return response(body);
			});
			const { onSaved } = mount();
			await ready();
			await save();
			await screen.findByText(/saved.*not.*confirmed/i);
			expect(onSaved).not.toHaveBeenCalled();
		},
	);
	// Break caught: old-scope read/write completion overwrites current editor or calls its parent.
	it.each(["initial", "write", "readback"])(
		"ignores late %s completion after changing target",
		async (phase) => {
			const held = hold(
				phase === "write" ? { success: true } : readback("instance-a", savedQuality),
			);
			let getsA = 0,
				puts = 0;
			transport((id, method) => {
				if (method === "PUT") {
					puts++;
					return phase === "write" ? held.promise : response({ success: true });
				}
				if (id === "instance-b") return response(readback("instance-b"));
				getsA++;
				return phase === "initial" || getsA > 1 ? held.promise : response(readback());
			});
			const { target, onSaved, client } = mount();
			const currentKey = ["trash-guides", "deployment", "preview", "template-a", "instance-b"];
			client.setQueryData(currentKey, { token: "current" });
			if (phase !== "initial") {
				await ready();
				await save();
				await waitFor(() => expect(puts).toBe(1));
				if (phase === "readback") await waitFor(() => expect(getsA).toBe(2));
			}
			target("instance-b");
			await ready();
			await act(async () =>
				held.resolve(
					response(phase === "write" ? { success: true } : readback("instance-a", savedQuality)),
				),
			);
			expect(
				screen.getByRole("dialog", { name: "Quality Settings for instance-b" }),
			).toBeInTheDocument();
			expect(screen.queryByText("Has Override")).not.toBeInTheDocument();
			expect(onSaved).not.toHaveBeenCalled();
			expect(client.getQueryState(currentKey)?.isInvalidated).toBe(false);
			if (phase === "write") expect(getsA).toBe(1);
		},
	);
	it("does not confirm an old write after unmount", async () => {
		const held = hold({ success: true });
		transport((_id, method) => (method === "PUT" ? held.promise : response(readback())));
		const { unmount, onSaved } = mount();
		await ready();
		await save();
		unmount();
		await act(async () => held.resolve(response({ success: true })));
		expect(onSaved).not.toHaveBeenCalled();
	});
	it("accepts the API's empty override object as confirmed template-default state", async () => {
		let gets = 0;
		transport((_id, method) =>
			method === "PUT"
				? response({ success: true })
				: response(
						++gets === 1
							? readback("instance-a", savedQuality)
							: { templateId: "template-a", instanceId: "instance-a", overrides: {} },
					),
		);
		const { onSaved } = mount();
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Reset to Template Default" }));
		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({
				templateId: "template-a",
				instanceId: "instance-a",
				overrides: {},
			}),
		);
	});
	it("keeps confirmed panel state scoped and resets it on authoritative template input change", async () => {
		let gets = 0;
		transport((_id, method) =>
			method === "PUT"
				? response({ success: true })
				: response(++gets === 1 ? readback() : readback("instance-a", savedQuality)),
		);
		const template = {
			id: "template-a",
			name: "Synthetic Template",
			serviceType: "RADARR",
			config: { customFormats: [], customFormatGroups: [], customQualityConfig: defaultQuality },
			instanceOverrides: {},
		} as unknown as TrashTemplate;
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		clients.push(client);
		const instances = [
			{ id: "instance-a", label: "instance-a", service: "RADARR" },
			{ id: "instance-b", label: "instance-b", service: "RADARR" },
		];
		const node = (t: TrashTemplate) =>
			wrap(<InstanceOverridesPanel template={t} instances={instances} />, client);
		const view = render(node(template));
		fireEvent.click(screen.getByRole("button", { name: /Instance Quality Overrides/ }));
		const row = () =>
			screen
				.getByText("instance-a", { selector: "div.text-sm.font-medium" })
				.closest("div.flex.items-center.justify-between") as HTMLElement;
		fireEvent.click(within(row()).getByRole("button", { name: "Customize" }));
		await ready();
		await save();
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(within(row()).getByRole("button", { name: "Edit" })).toBeInTheDocument();
		const otherRow = screen
			.getByText("instance-b", { selector: "div.text-sm.font-medium" })
			.closest("div.flex.items-center.justify-between") as HTMLElement;
		expect(within(otherRow).getByText("Using template default")).toBeInTheDocument();
		view.rerender(node({ ...template, id: "template-b" }));
		expect(screen.getByRole("button", { name: /Instance Quality Overrides/ })).toHaveTextContent(
			"All instances use template default",
		);
		view.rerender(
			node({
				...template,
				instanceOverrides: { "instance-b": readback("instance-b", savedQuality).overrides },
			}),
		);
		expect(screen.getByRole("button", { name: /Instance Quality Overrides/ })).toHaveTextContent(
			/1 instance.*with custom quality config/,
		);
	});
});
