import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturedLinks } = vi.hoisted(() => ({
	capturedLinks: [] as Array<{
		href: string;
		prefetch?: boolean;
		onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
	}>,
}));

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		prefetch,
		onClick,
	}: {
		children: React.ReactNode;
		href: string;
		prefetch?: boolean;
		onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
	}) => {
		const clickSpy = vi.fn(onClick);
		capturedLinks.push({ href, prefetch, onClick: clickSpy });
		const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
			event.preventDefault();
			clickSpy(event);
		};
		return (
			<a href={href} onClick={handleClick}>
				{children}
			</a>
		);
	},
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/dashboard",
}));

vi.mock("../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: { from: "#000000", to: "#111111", glow: "#222222" },
	}),
}));

vi.mock("../../../providers/color-theme-provider", () => ({
	useColorTheme: () => ({ colorTheme: "arr" }),
}));

vi.mock("framer-motion", () => {
	const passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>;
	return {
		AnimatePresence: passthrough,
		LayoutGroup: passthrough,
		motion: { button: passthrough, div: passthrough },
	};
});

import { Sidebar } from "../sidebar";

describe("Sidebar navigation prefetching", () => {
	beforeEach(() => {
		capturedLinks.length = 0;
		localStorage.clear();
	});

	it("disables speculative prefetch while retaining clickable destinations", () => {
		render(<Sidebar />);

		expect(capturedLinks.length).toBeGreaterThan(0);
		expect(capturedLinks.every((link) => link.prefetch === false)).toBe(true);

		const libraryLink = screen.getByRole("link", { name: /^Library$/i });
		const libraryCapture = capturedLinks.filter((link) => link.href === "/library").at(-1);
		expect(libraryLink).toHaveAttribute("href", "/library");
		fireEvent.click(libraryLink);
		expect(libraryCapture?.onClick).toHaveBeenCalledTimes(1);
	});
});
