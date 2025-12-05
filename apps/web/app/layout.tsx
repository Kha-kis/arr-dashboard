import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { RootProviders } from "../src/providers/root-providers";
import { LayoutWrapper } from "../src/components/layout/layout-wrapper";
import { AuthGate } from "../src/components/auth/auth-gate";
import { Toaster } from "../src/components/ui";

const inter = Inter({ subsets: ["latin"] });

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

const RootLayout = ({ children }: RootLayoutProps) => (
	<html lang="en" suppressHydrationWarning>
		<body className={inter.className}>
			<RootProviders>
				<AuthGate>
					<LayoutWrapper>{children}</LayoutWrapper>
				</AuthGate>
				<Toaster />
			</RootProviders>
		</body>
	</html>
);

export default RootLayout;
