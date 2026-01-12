"use client";

import { Toaster as Sonner } from "sonner";

/**
 * Toast Notification System
 *
 * Built on Sonner with custom styling to match design system.
 *
 * Usage:
 * ```tsx
 * import { toast } from 'sonner';
 *
 * toast.success('Operation successful!');
 * toast.error('Something went wrong');
 * toast.info('Information message');
 * toast.warning('Warning message');
 * toast.promise(promise, {
 *   loading: 'Loading...',
 *   success: 'Success!',
 *   error: 'Error!'
 * });
 * ```
 */

type ToasterProps = React.ComponentProps<typeof Sonner>;

export function Toaster({ ...props }: ToasterProps) {
	return (
		<Sonner
			className="toaster group"
			position="top-right"
			expand={false}
			richColors
			closeButton
			toastOptions={{
				classNames: {
					toast:
						"group toast group-[.toaster]:bg-card/95 group-[.toaster]:backdrop-blur-xl group-[.toaster]:border-border/50 group-[.toaster]:text-foreground group-[.toaster]:shadow-lg",
					description: "group-[.toast]:text-muted-foreground",
					actionButton: "group-[.toast]:bg-primary group-[.toast]:text-white",
					cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
					closeButton:
						"group-[.toast]:bg-muted group-[.toast]:border-border/50 group-[.toast]:text-muted-foreground hover:group-[.toast]:bg-muted/80",
					success: "group-[.toaster]:border-success/30 group-[.toaster]:text-success-fg",
					error: "group-[.toaster]:border-danger/30 group-[.toaster]:text-danger-fg",
					warning: "group-[.toaster]:border-warning/30 group-[.toaster]:text-warning-fg",
					info: "group-[.toaster]:border-info/30 group-[.toaster]:text-info-fg",
				},
			}}
			{...props}
		/>
	);
}

export { toast } from "sonner";
