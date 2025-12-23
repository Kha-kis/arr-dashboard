"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { SSEProvider } from "../../providers/sse-provider";

const ROUTES_WITHOUT_LAYOUT = new Set(["/login", "/setup"]);

interface LayoutWrapperProps {
	readonly children: React.ReactNode;
}

export const LayoutWrapper = ({ children }: LayoutWrapperProps) => {
	const pathname = usePathname();
	const showLayout = !ROUTES_WITHOUT_LAYOUT.has(pathname);

	if (!showLayout) {
		return <>{children}</>;
	}

	return (
		<SSEProvider>
			<div className="flex min-h-screen bg-bg relative">
				{/* Premium gradient mesh background */}
				<div
					className="fixed inset-0 pointer-events-none opacity-40"
					style={{ background: "var(--gradient-mesh)" }}
				/>

				<Sidebar />
				<div className="flex flex-1 flex-col relative z-10">
					<TopBar />
					<div className="flex-1 p-6">{children}</div>
				</div>
			</div>
		</SSEProvider>
	);
};
