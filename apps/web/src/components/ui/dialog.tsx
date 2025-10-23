"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

export interface DialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: ReactNode;
	size?: "sm" | "md" | "lg" | "xl";
}

const sizeStyles = {
	sm: "max-w-md",
	md: "max-w-2xl",
	lg: "max-w-3xl",
	xl: "max-w-5xl",
};

export const Dialog = ({ open, onOpenChange, children, size = "md" }: DialogProps) => {
	const dialogRef = useRef<HTMLDivElement>(null);

	// Handle ESC key
	useEffect(() => {
		const handleEsc = (e: KeyboardEvent) => {
			if (e.key === "Escape" && open) {
				onOpenChange(false);
			}
		};

		document.addEventListener("keydown", handleEsc);
		return () => document.removeEventListener("keydown", handleEsc);
	}, [open, onOpenChange]);

	// Prevent body scroll when modal is open
	useEffect(() => {
		if (open) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [open]);

	// Focus management: Focus first focusable element when dialog opens
	useEffect(() => {
		if (open && dialogRef.current) {
			const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			const firstElement = focusableElements[0];
			if (firstElement) {
				// Delay focus to ensure DOM is ready
				setTimeout(() => firstElement.focus(), 0);
			}
		}
	}, [open]);

	// Focus trap: Keep focus within dialog
	useEffect(() => {
		if (!open || !dialogRef.current) return;

		const handleTabKey = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || !dialogRef.current) return;

			const focusableElements = Array.from(
				dialogRef.current.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				)
			);

			if (focusableElements.length === 0) return;

			const firstElement = focusableElements[0];
			const lastElement = focusableElements[focusableElements.length - 1];

			if (e.shiftKey) {
				// Shift + Tab: Moving backwards
				if (document.activeElement === firstElement) {
					e.preventDefault();
					lastElement.focus();
				}
			} else {
				// Tab: Moving forwards
				if (document.activeElement === lastElement) {
					e.preventDefault();
					firstElement.focus();
				}
			}
		};

		document.addEventListener("keydown", handleTabKey);
		return () => document.removeEventListener("keydown", handleTabKey);
	}, [open]);

	if (!open) return null;

	const modalContent = (
		<div className="fixed inset-0 z-modal-backdrop isolate">
			{/* Backdrop */}
			<div
				className="fixed inset-0 bg-bg/80 backdrop-blur"
				onClick={() => onOpenChange(false)}
				aria-hidden="true"
			/>

			{/* Dialog Container */}
			<div className="fixed inset-0 flex items-center justify-center p-4 sm:p-6 md:p-8 pointer-events-none">
				<div
					ref={dialogRef}
					className={cn(
						"relative z-modal w-full overflow-hidden rounded-2xl border border-border bg-bg-subtle/95 shadow-xl pointer-events-auto",
						"max-h-[90vh] flex flex-col",
						sizeStyles[size],
					)}
					onClick={(e) => e.stopPropagation()}
					role="dialog"
					aria-modal="true"
				>
					{children}
				</div>
			</div>
		</div>
	);

	// Render modal in a portal at document.body to escape any stacking contexts
	return typeof window !== "undefined"
		? createPortal(modalContent, document.body)
		: null;
};

export interface DialogHeaderProps {
	children: ReactNode;
	className?: string;
}

export const DialogHeader = ({ children, className }: DialogHeaderProps) => (
	<div className={cn("flex flex-col space-y-1.5 px-6 pt-6", className)}>{children}</div>
);

export interface DialogTitleProps {
	children: ReactNode;
	className?: string;
}

export const DialogTitle = ({ children, className }: DialogTitleProps) => (
	<h2 className={cn("text-lg font-semibold text-fg", className)}>{children}</h2>
);

export interface DialogDescriptionProps {
	children: ReactNode;
	className?: string;
}

export const DialogDescription = ({ children, className }: DialogDescriptionProps) => (
	<p className={cn("text-sm text-fg-muted", className)}>{children}</p>
);

export interface DialogContentProps {
	children: ReactNode;
	className?: string;
}

export const DialogContent = ({ children, className }: DialogContentProps) => (
	<div className={cn("flex-1 overflow-y-auto px-6 py-4", className)}>{children}</div>
);

export interface DialogFooterProps {
	children: ReactNode;
	className?: string;
}

export const DialogFooter = ({ children, className }: DialogFooterProps) => (
	<div className={cn("flex items-center justify-end gap-3 px-6 pb-6 pt-4", className)}>
		{children}
	</div>
);
