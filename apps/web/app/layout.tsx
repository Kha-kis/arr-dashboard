import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { RootProviders } from "../src/providers/root-providers";
import { LayoutWrapper } from "../src/components/layout/layout-wrapper";
import { AuthGate } from "../src/components/auth/auth-gate";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Arr Control Center",
  description: "Centralized management dashboard for Sonarr, Radarr, and Prowlarr",
};

interface RootLayoutProps {
  readonly children: React.ReactNode;
}

const RootLayout = ({ children }: RootLayoutProps) => (
  <html lang="en" suppressHydrationWarning>
    <body className={inter.className + " bg-slate-950 text-white min-h-screen"}>
      <RootProviders>
        <AuthGate>
          <LayoutWrapper>{children}</LayoutWrapper>
        </AuthGate>
      </RootProviders>
    </body>
  </html>
);

export default RootLayout;
