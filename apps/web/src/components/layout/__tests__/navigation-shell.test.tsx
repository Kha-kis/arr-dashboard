import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";
import { authKeys } from "../../../lib/query-keys";
import { ColorThemeProvider } from "../../../providers/color-theme-provider";
import { LayoutWrapper } from "../layout-wrapper";

const state = vi.hoisted(() => ({
	pathname: "/dashboard",
	replace: vi.fn(),
	push: vi.fn(),
	logout: vi.fn(),
	fetchCurrentUser: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => state.pathname,
	useRouter: () => ({ replace: state.replace, push: state.push }),
}));
vi.mock("next/link", () => ({
	default: ({ prefetch: _prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) => (
		<a
			{...props}
			onClick={(event) => {
				event.preventDefault();
				props.onClick?.(event);
			}}
		/>
	),
}));
vi.mock("../../../lib/api-client/auth", () => ({
	logout: state.logout,
	fetchCurrentUser: state.fetchCurrentUser,
}));
let client: QueryClient;
let resize: Set<() => void>;
let desktop: boolean;
beforeEach(() => {
	localStorage.clear();
	state.pathname = "/dashboard";
	desktop = false;
	resize = new Set();
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	client.setQueryData(authKeys.currentUser, {
		id: "synthetic-user",
		username: "Synthetic Viewer",
		mustChangePassword: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		hasPassword: true,
		hasTmdbApiKey: false,
	});
	state.logout.mockResolvedValue(undefined);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			get matches() {
				return query === "(min-width: 1024px)" && desktop;
			},
			media: query,
			addListener() {},
			removeListener() {},
			addEventListener: (_: string, listener: () => void) => resize.add(listener),
			removeEventListener: (_: string, listener: () => void) => resize.delete(listener),
		})),
	);
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		value: vi.fn(),
		configurable: true,
	});
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
function Shell() {
	return (
		<QueryClientProvider client={client}>
			<ThemeProvider>
				<ColorThemeProvider>
					<IncognitoProvider>
						<LayoutWrapper>
							<button type="button">Page action</button>
						</LayoutWrapper>
					</IncognitoProvider>
				</ColorThemeProvider>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
async function drawer() {
	const trigger = screen.getByRole("button", { name: "Open menu" });
	trigger.focus();
	fireEvent.click(trigger);
	const dialog = await screen.findByRole("dialog", { name: "Navigation menu" });
	await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	return { trigger, dialog };
}
describe("Navigation shell", () => {
	it("dismisses a direct primary backdrop click without a preceding pointerdown", async () => {
		render(<Shell />);
		const { trigger, dialog } = await drawer();
		fireEvent.click(dialog.previousElementSibling!, { button: 0, ctrlKey: false });
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		await waitFor(() => expect(trigger).toHaveFocus());
		expect(document.body).not.toHaveAttribute("data-scroll-locked");
	});

	it.each([
		{ button: 2, ctrlKey: false },
		{ button: 0, ctrlKey: true },
	])("keeps the drawer open for a guarded backdrop click %j", async (click) => {
		render(<Shell />);
		const { dialog } = await drawer();
		fireEvent.click(dialog.previousElementSibling!, click);
		expect(dialog).toBeInTheDocument();
		expect(document.body).toHaveAttribute("data-scroll-locked");
	});

	it("does not dismiss for content or a bubbled overlay descendant click", async () => {
		render(<Shell />);
		const { dialog } = await drawer();
		fireEvent.click(within(dialog).getByRole("heading", { name: "Arr Control" }));
		expect(dialog).toBeInTheDocument();
		const child = document.createElement("span");
		dialog.previousElementSibling!.append(child);
		fireEvent.click(child, { button: 0, ctrlKey: false });
		expect(dialog).toBeInTheDocument();
	});

	it("retains inherited arr theme selectors for the mobile heading and muted text", async () => {
		const previousTheme = document.documentElement.getAttribute("data-theme");
		document.documentElement.setAttribute("data-theme", "arr");
		localStorage.setItem("theme", "light");
		try {
			render(<Shell />);
			const { dialog } = await drawer();
			const heading = within(dialog).getByRole("heading", { name: "Arr Control", level: 1 });
			const tagline = within(dialog).getByText("Media Server");
			const mutedLink = within(dialog).getByRole("link", { name: "Library" });
			// These are the existing sidebar-specific CSS consumers, not a pixel assertion.
			expect(heading.matches('[data-theme="arr"] aside h1')).toBe(true);
			expect(tagline.matches('[data-theme="arr"] aside p')).toBe(true);
			expect(mutedLink.matches('[data-theme="arr"] aside .text-muted-foreground')).toBe(true);
		} finally {
			if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
			else document.documentElement.setAttribute("data-theme", previousTheme);
		}
	});

	it("retains navigation destinations, current-page semantics, and persisted collapsed groups", async () => {
		localStorage.setItem("sidebar-collapsed-groups", JSON.stringify(["maintenance", "overview"]));
		const view = render(<Shell />);
		const nav = screen.getByRole("navigation");
		expect(within(nav).getByRole("link", { name: "Dashboard" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(within(nav).getByRole("button", { name: "Overview" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(within(nav).getByRole("button", { name: "Maintenance" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		fireEvent.click(within(nav).getByRole("button", { name: "Maintenance" }));
		expect(within(nav).getByRole("link", { name: "History" })).toHaveAttribute("href", "/history");
		expect(JSON.parse(localStorage.getItem("sidebar-collapsed-groups")!)).toEqual([]);
		state.pathname = "/calendar";
		view.rerender(<Shell />);
		expect(within(nav).getByRole("link", { name: "Calendar" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(within(nav).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
			"aria-current",
		);
	});
	it("puts the menu trigger in the header alongside existing privacy, account, and sign-out controls", async () => {
		render(<Shell />);
		expect(screen.getByRole("banner")).toContainElement(
			screen.getByRole("button", { name: "Open menu" }),
		);
		expect(screen.getByText("Synthetic Viewer")).toBeInTheDocument();
		fireEvent.click(screen.getByTitle("Hide sensitive data"));
		expect(screen.queryByText("Synthetic Viewer")).not.toBeInTheDocument();
		expect(screen.getByTitle("Show real data")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		await waitFor(() => expect(state.replace).toHaveBeenCalledWith("/login"));
		expect(state.logout).toHaveBeenCalledOnce();
		expect(state.fetchCurrentUser).not.toHaveBeenCalled();
	});
	it("contains focus and restores the menu trigger after Escape, close, and backdrop dismissal", async () => {
		render(<Shell />);
		let { trigger, dialog } = await drawer();
		const close = within(dialog).getByRole("button", { name: "Close menu" });
		const last = within(dialog).getByRole("link", { name: "Settings" });
		close.focus();
		fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
		expect(last).toHaveFocus();
		fireEvent.keyDown(last, { key: "Tab" });
		expect(close).toHaveFocus();
		screen.getByRole("button", { name: "Page action", hidden: true }).focus();
		expect(dialog.contains(document.activeElement)).toBe(true);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await waitFor(() => expect(trigger).toHaveFocus());
		({ dialog } = await drawer());
		fireEvent.click(within(dialog).getByRole("button", { name: "Close menu" }));
		await waitFor(() => expect(trigger).toHaveFocus());
		({ dialog } = await drawer());
		fireEvent.pointerDown(dialog.previousElementSibling!, { button: 0, ctrlKey: false });
		fireEvent.click(dialog.previousElementSibling!, { button: 0, ctrlKey: false });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await waitFor(() => expect(trigger).toHaveFocus());
	});
	it("closes on selection, pathname changes, and widening without reopening or leaking modal state", async () => {
		const view = render(<Shell />);
		let { dialog } = await drawer();
		fireEvent.click(within(dialog).getByRole("link", { name: "Library" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await drawer();
		state.pathname = "/calendar";
		view.rerender(<Shell />);
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await drawer();
		act(() => {
			desktop = true;
			for (const listener of resize) listener();
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		act(() => {
			desktop = false;
			for (const listener of resize) listener();
		});
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		await drawer();
		view.unmount();
		await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));
		expect(document.body).not.toHaveAttribute("data-scroll-locked");
		expect(resize.size).toBe(0);
	});
	it("closes only the top palette on first Escape and restores drawer focus before second Escape", async () => {
		render(<Shell />);
		const { trigger, dialog } = await drawer();
		const link = within(dialog).getByRole("link", { name: "Library" });
		link.focus();
		fireEvent.keyDown(link, { key: "k", ctrlKey: true });
		const input = await screen.findByPlaceholderText("Type a command or search...");
		await waitFor(() => expect(input).toHaveFocus());
		link.focus();
		expect(input).toHaveFocus();
		fireEvent.keyDown(input, { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByPlaceholderText("Type a command or search...")).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("dialog", { name: "Navigation menu" })).toBeInTheDocument();
		await waitFor(() => expect(link).toHaveFocus());
		fireEvent.keyDown(link, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await waitFor(() => expect(trigger).toHaveFocus());
	});
	it.each(["/login", "/setup"])("keeps %s without a shell", (path) => {
		state.pathname = path;
		render(<Shell />);
		expect(screen.getByRole("button", { name: "Page action" })).toBeInTheDocument();
		expect(screen.queryByRole("banner")).not.toBeInTheDocument();
		expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
	});
	it("preserves the guest sign-in destination", () => {
		client.setQueryData(authKeys.currentUser, null);
		render(<Shell />);
		expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
	});
});
