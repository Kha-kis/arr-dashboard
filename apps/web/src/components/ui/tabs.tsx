/**
 * Tabs Component
 * Simple, accessible tabs for organizing content
 */

"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface TabsContextValue {
	activeTab: string;
	setActiveTab: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

function useTabsContext() {
	const context = useContext(TabsContext);
	if (!context) {
		throw new Error("Tabs compound components must be used within Tabs");
	}
	return context;
}

interface TabsProps {
	defaultValue: string;
	children: ReactNode;
	className?: string;
}

export function Tabs({ defaultValue, children, className }: TabsProps) {
	const [activeTab, setActiveTab] = useState(defaultValue);

	return (
		<TabsContext.Provider value={{ activeTab, setActiveTab }}>
			<div className={cn("w-full", className)}>{children}</div>
		</TabsContext.Provider>
	);
}

interface TabsListProps {
	children: ReactNode;
	className?: string;
}

export function TabsList({ children, className }: TabsListProps) {
	return (
		<div
			className={cn(
				"inline-flex h-10 items-center justify-start rounded-lg bg-bg-muted p-1 text-fg-muted gap-1",
				className,
			)}
			role="tablist"
		>
			{children}
		</div>
	);
}

interface TabsTriggerProps {
	value: string;
	children: ReactNode;
	className?: string;
}

export function TabsTrigger({ value, children, className }: TabsTriggerProps) {
	const { activeTab, setActiveTab } = useTabsContext();
	const isActive = activeTab === value;

	return (
		<button
			type="button"
			role="tab"
			aria-selected={isActive}
			className={cn(
				"inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ring-offset-bg transition-all",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
				"disabled:pointer-events-none disabled:opacity-50",
				isActive
					? "bg-bg text-fg shadow-sm"
					: "text-fg-muted hover:text-fg hover:bg-bg-subtle/50",
				className,
			)}
			onClick={() => setActiveTab(value)}
		>
			{children}
		</button>
	);
}

interface TabsContentProps {
	value: string;
	children: ReactNode;
	className?: string;
}

export function TabsContent({ value, children, className }: TabsContentProps) {
	const { activeTab } = useTabsContext();

	if (activeTab !== value) return null;

	return (
		<div
			role="tabpanel"
			className={cn(
				"mt-2 ring-offset-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
				className,
			)}
		>
			{children}
		</div>
	);
}
