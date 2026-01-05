import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { RootProviders } from "../src/providers/root-providers";
import { LayoutWrapper } from "../src/components/layout/layout-wrapper";
import { AuthGate } from "../src/components/auth/auth-gate";
import { Toaster } from "../src/components/ui";

/**
 * Premium Typography System
 *
 * Display Font: Satoshi - A modern geometric sans-serif with personality
 * Body Font: DM Sans - Highly readable, works great at all sizes
 *
 * Both are variable fonts for optimal performance and flexibility.
 */

// Satoshi - Display font for headings and brand elements
// Using local font for Satoshi as it's not on Google Fonts
const satoshi = localFont({
	src: [
		{
			path: "../public/fonts/Satoshi-Variable.woff2",
			style: "normal",
		},
		{
			path: "../public/fonts/Satoshi-VariableItalic.woff2",
			style: "italic",
		},
	],
	variable: "--font-display",
	display: "swap",
	preload: true,
});

// DM Sans - Body font for UI text and content
const dmSans = DM_Sans({
	subsets: ["latin"],
	variable: "--font-body",
	display: "swap",
});

export const metadata: Metadata = {
	title: "Arr Control Center",
	description: "Centralized management dashboard for Sonarr, Radarr, and Prowlarr",
	icons: {
		icon: [
			{ url: "/icon.svg", type: "image/svg+xml" },
			{ url: "/icon.png", type: "image/png" },
		],
		apple: "/icon.png",
	},
};

interface RootLayoutProps {
	readonly children: React.ReactNode;
}

const RootLayout = ({ children }: RootLayoutProps) => {
	return (
		<html lang="en" suppressHydrationWarning className={`${satoshi.variable} ${dmSans.variable}`}>
			<body className="font-body antialiased">
				<RootProviders>
					<AuthGate>
						<LayoutWrapper>{children}</LayoutWrapper>
					</AuthGate>
					<Toaster />
				</RootProviders>
			</body>
		</html>
	);
};

export default RootLayout;
