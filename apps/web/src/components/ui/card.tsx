"use client";

import { cn } from "../../lib/utils";

const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"group relative rounded-2xl border border-border/50 p-6 transition-all duration-300",
			"bg-bg-subtle/40 backdrop-blur-xl",
			"shadow-lg shadow-black/10",
			"hover:shadow-xl hover:shadow-primary/5 hover:border-border/70 hover:-translate-y-0.5",
			"before:absolute before:inset-0 before:rounded-2xl before:bg-gradient-to-br before:from-white/5 before:to-transparent before:opacity-0 hover:before:opacity-100 before:transition-opacity before:pointer-events-none",
			className,
		)}
		{...props}
	/>
);

const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("mb-4 space-y-1.5", className)} {...props} />
);

const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
	<h3 className={cn("text-lg font-semibold text-fg", className)} {...props} />
);

const CardDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
	<p className={cn("text-sm text-fg-muted", className)} {...props} />
);

const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div className={cn("text-sm text-fg-subtle", className)} {...props} />
);

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
