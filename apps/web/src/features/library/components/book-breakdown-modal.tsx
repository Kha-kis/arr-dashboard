"use client";

import { useState } from "react";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type { LibraryItem, LibraryBook } from "@arr/shared";
import {
	BookOpen,
	ChevronDown,
	ChevronRight,
	Loader2,
	Search,
	X,
	AlertTriangle,
	CheckCircle2,
	HardDrive,
} from "lucide-react";
import { Button } from "../../../components/ui";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useBooksQuery } from "../../../hooks/api/useLibrary";
import { formatBytes } from "../lib/library-utils";

// ============================================================================
// Types
// ============================================================================

interface BookBreakdownModalProps {
	/** The library item (must be an author) */
	item: LibraryItem;
	/** Callback to close the modal */
	onClose: () => void;
	/** Callback to toggle monitoring for a book */
	onToggleBook: (bookId: number, nextMonitored: boolean) => void;
	/** Callback to search for books */
	onSearchBook: (bookIds: number[]) => void;
	/** The key representing which action is currently pending */
	pendingActionKey: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const READARR_COLOR = SERVICE_GRADIENTS.readarr.from;

// ============================================================================
// Sub-components
// ============================================================================

const BookBadge = ({
	tone,
	children,
}: {
	tone: "success" | "warning" | "error" | "muted";
	children: React.ReactNode;
}) => {
	const colors = {
		success: SEMANTIC_COLORS.success,
		warning: SEMANTIC_COLORS.warning,
		error: SEMANTIC_COLORS.error,
		muted: { bg: "rgba(100, 116, 139, 0.1)", border: "rgba(100, 116, 139, 0.3)", text: "#94a3b8" },
	};
	const color = colors[tone];

	return (
		<span
			className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
			style={{
				backgroundColor: color.bg,
				border: `1px solid ${color.border}`,
				color: color.text,
			}}
		>
			{children}
		</span>
	);
};

// ============================================================================
// Main Component
// ============================================================================

export const BookBreakdownModal = ({
	item,
	onClose,
	onToggleBook,
	onSearchBook,
	pendingActionKey,
}: BookBreakdownModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [expandedBooks, setExpandedBooks] = useState<Set<number>>(new Set());
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);

	// Fetch books on-demand when modal opens
	const { data, isLoading, isError } = useBooksQuery({
		instanceId: item.instanceId,
		authorId: item.id,
		enabled: item.type === "author",
	});

	if (item.type !== "author") {
		return null;
	}

	const books = data?.books ?? [];

	const toggleBookExpanded = (bookId: number) => {
		setExpandedBooks((prev) => {
			const next = new Set(prev);
			if (next.has(bookId)) {
				next.delete(bookId);
			} else {
				next.add(bookId);
			}
			return next;
		});
	};

	// Compute overall stats from fetched books
	const totalBooks = books.length;
	const downloadedBooks = books.filter((b) => b.hasFile).length;
	const missingBooks = books.filter((b) => !b.hasFile && b.monitored !== false).length;
	const overallProgress = totalBooks > 0 ? Math.round((downloadedBooks / totalBooks) * 100) : 0;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="book-breakdown-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${READARR_COLOR}15`,
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div
					className="p-6 border-b border-border/30"
					style={{
						background: `linear-gradient(135deg, ${READARR_COLOR}08, transparent)`,
					}}
				>
					<div className="flex items-start gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `${READARR_COLOR}20`,
								border: `1px solid ${READARR_COLOR}30`,
							}}
						>
							<BookOpen className="h-6 w-6" style={{ color: READARR_COLOR }} />
						</div>
						<div className="flex-1 min-w-0">
							<h2 id="book-breakdown-title" className="text-xl font-bold text-foreground">{item.title}</h2>
							<div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-muted-foreground">
								<span>{item.instanceName}</span>
								<span>•</span>
								<span className="flex items-center gap-1">
									<BookOpen className="h-3.5 w-3.5" />
									{isLoading ? "..." : `${books.length} book${books.length !== 1 ? "s" : ""}`}
								</span>
								{!isLoading && (
									missingBooks > 0 ? (
										<BookBadge tone="warning">
											<AlertTriangle className="h-3 w-3" />
											{missingBooks} missing book{missingBooks !== 1 ? "s" : ""}
										</BookBadge>
									) : books.length > 0 ? (
										<BookBadge tone="success">
											<CheckCircle2 className="h-3 w-3" />
											Complete
										</BookBadge>
									) : null
								)}
							</div>

							{/* Overall Progress */}
							{!isLoading && books.length > 0 && (
								<div className="mt-4 space-y-1.5">
									<div className="flex items-center justify-between text-xs">
										<span className="text-muted-foreground">Overall Progress</span>
										<span className="font-medium text-foreground">
											{downloadedBooks}/{totalBooks} books ({overallProgress}%)
										</span>
									</div>
									<div className="h-2 rounded-full bg-muted/30 overflow-hidden">
										<div
											className="h-full transition-all duration-500 rounded-full"
											style={{
												width: `${overallProgress}%`,
												background:
													missingBooks > 0
														? `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.from}, ${SEMANTIC_COLORS.warning.to})`
														: `linear-gradient(90deg, ${SEMANTIC_COLORS.success.from}, ${SEMANTIC_COLORS.success.to})`,
											}}
										/>
									</div>
								</div>
							)}
						</div>
					</div>
				</div>

				{/* Book List */}
				<div className="max-h-[calc(90vh-200px)] overflow-y-auto p-6 space-y-3">
					{isLoading && (
						<div className="flex items-center justify-center py-12 gap-3 text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" />
							<span className="text-sm">Loading books...</span>
						</div>
					)}

					{isError && (
						<div
							className="p-4 rounded-xl flex items-start gap-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: SEMANTIC_COLORS.error.from }} />
							<p className="text-xs" style={{ color: SEMANTIC_COLORS.error.text }}>
								Failed to load books. Please try closing and reopening the modal.
							</p>
						</div>
					)}

					{!isLoading && !isError && books.length === 0 && (
						<div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
							<BookOpen className="h-8 w-8 mb-2 opacity-50" />
							<p className="text-sm">No books found for this author.</p>
						</div>
					)}

					{books.map((book, index) => (
						<BookRow
							key={book.id}
							book={book}
							item={item}
							index={index}
							isExpanded={expandedBooks.has(book.id)}
							onToggleExpanded={() => toggleBookExpanded(book.id)}
							onToggleBook={onToggleBook}
							onSearchBook={onSearchBook}
							pendingActionKey={pendingActionKey}
							themeGradient={themeGradient}
						/>
					))}
				</div>
			</div>
		</div>
	);
};

// ============================================================================
// BookRow Component
// ============================================================================

interface BookRowProps {
	book: LibraryBook;
	item: LibraryItem;
	index: number;
	isExpanded: boolean;
	onToggleExpanded: () => void;
	onToggleBook: (bookId: number, nextMonitored: boolean) => void;
	onSearchBook: (bookIds: number[]) => void;
	pendingActionKey: string | null;
	themeGradient: { from: string; to: string; glow: string; fromLight: string; fromMedium: string; fromMuted: string };
}

const BookRow = ({
	book,
	item,
	index,
	isExpanded,
	onToggleExpanded,
	onToggleBook,
	onSearchBook,
	pendingActionKey,
	themeGradient,
}: BookRowProps) => {
	const bookKey = `${item.instanceId}:${item.id}:${book.id}`;
	const monitorKey = `monitor:${bookKey}`;
	const searchKey = `search:${item.instanceId}:${item.id}:${book.id}`;
	const bookMonitorPending = pendingActionKey === monitorKey;
	const bookSearchPending = pendingActionKey === searchKey;

	const releaseYear = book.releaseDate ? new Date(book.releaseDate).getFullYear() : null;
	const sizeLabel = book.statistics?.sizeOnDisk ? formatBytes(book.statistics.sizeOnDisk) : null;

	// Get cover image URL
	const coverImage = book.images?.find((img) => img.coverType === "cover" || img.coverType === "poster")?.url;

	return (
		<div
			className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden transition-all duration-300 hover:border-border/80 animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${index * 50}ms`,
				animationFillMode: "backwards",
				...(isExpanded && {
					borderColor: `${themeGradient.from}40`,
				}),
			}}
		>
			<div className="px-4 py-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<button
						onClick={onToggleExpanded}
						aria-expanded={isExpanded}
						className="flex items-center gap-2 text-left hover:text-foreground transition-colors group min-w-0 flex-1"
					>
						<div
							className="flex h-6 w-6 items-center justify-center rounded-md transition-colors shrink-0"
							style={{
								background: isExpanded ? `${themeGradient.from}20` : "transparent",
							}}
						>
							{isExpanded ? (
								<ChevronDown className="h-4 w-4" style={{ color: themeGradient.from }} />
							) : (
								<ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
							)}
						</div>
						{coverImage ? (
							<div className="h-10 w-10 overflow-hidden rounded-md border border-border/50 bg-muted shrink-0">
								{/* eslint-disable-next-line @next/next/no-img-element -- External cover from Readarr instance */}
								<img src={coverImage} alt="" className="h-full w-full object-cover" />
							</div>
						) : (
							<div className="flex h-10 w-10 items-center justify-center rounded-md border border-border/50 bg-muted/30 shrink-0">
								<BookOpen className="h-4 w-4 text-muted-foreground" />
							</div>
						)}
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<p className="text-sm font-medium text-foreground truncate">{book.title}</p>
								{releaseYear && (
									<span className="text-xs text-muted-foreground">{releaseYear}</span>
								)}
							</div>
							{book.pageCount && book.pageCount > 0 && (
								<p className="text-xs text-muted-foreground">{book.pageCount} pages</p>
							)}
						</div>
					</button>

					<div className="flex flex-wrap items-center gap-2">
						<BookBadge tone={book.hasFile ? "success" : "warning"}>
							{book.hasFile ? "Downloaded" : "Missing"}
						</BookBadge>
						{book.monitored === false && <BookBadge tone="muted">Unmonitored</BookBadge>}
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="gap-1.5"
							disabled={bookMonitorPending}
							onClick={() => onToggleBook(book.id, !(book.monitored ?? false))}
						>
							{bookMonitorPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : book.monitored === false ? (
								"Monitor"
							) : (
								"Unmonitor"
							)}
						</Button>
						<Button
							type="button"
							size="sm"
							className="gap-1.5"
							disabled={bookSearchPending}
							onClick={() => onSearchBook([book.id])}
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
							}}
						>
							{bookSearchPending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Search className="h-3.5 w-3.5" />
							)}
							Search
						</Button>
					</div>
				</div>
			</div>

			{/* Expanded details */}
			{isExpanded && (
				<div
					className="border-t border-border/30 px-4 py-4 space-y-4"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}05, transparent)`,
					}}
				>
					<div className="flex gap-4">
						{/* Book cover */}
						{coverImage && (
							<div className="h-32 w-24 overflow-hidden rounded-lg border border-border/50 bg-muted shadow-md shrink-0">
								{/* eslint-disable-next-line @next/next/no-img-element -- External cover from Readarr instance */}
								<img src={coverImage} alt={book.title} className="h-full w-full object-cover" />
							</div>
						)}

						<div className="flex-1 min-w-0 space-y-3">
							{/* Stats grid */}
							<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
								<div
									className="rounded-lg p-3"
									style={{
										backgroundColor: book.hasFile ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
										border: `1px solid ${book.hasFile ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.error.border}`,
									}}
								>
									<p className="text-xs" style={{ color: book.hasFile ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.error.text }}>
										File Status
									</p>
									<p className="mt-1 text-sm font-semibold" style={{ color: book.hasFile ? SEMANTIC_COLORS.success.from : SEMANTIC_COLORS.error.from }}>
										{book.hasFile ? "Downloaded" : "Missing"}
									</p>
								</div>
								{book.pageCount && book.pageCount > 0 && (
									<div className="rounded-lg border border-border/50 bg-card/30 p-3">
										<p className="text-xs text-muted-foreground">Pages</p>
										<p className="mt-1 text-lg font-semibold text-foreground">{book.pageCount}</p>
									</div>
								)}
								{sizeLabel && (
									<div className="rounded-lg border border-border/50 bg-card/30 p-3">
										<p className="text-xs text-muted-foreground flex items-center gap-1">
											<HardDrive className="h-3 w-3" />
											On Disk
										</p>
										<p className="mt-1 text-sm font-semibold text-foreground">{sizeLabel}</p>
									</div>
								)}
							</div>

							{/* Overview */}
							{book.overview && (
								<p className="text-xs leading-relaxed text-muted-foreground line-clamp-4">{book.overview}</p>
							)}

							{/* Genre tags */}
							{book.genres && book.genres.length > 0 && (
								<div className="flex flex-wrap gap-1.5">
									{book.genres.map((genre) => (
										<span
											key={genre}
											className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
										>
											{genre}
										</span>
									))}
								</div>
							)}

							{/* External IDs */}
							<div className="flex flex-wrap gap-2">
								{book.foreignBookId && (
									<a
										href={`https://www.goodreads.com/book/show/${book.foreignBookId}`}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
									>
										Goodreads
									</a>
								)}
								{book.asin && (
									<a
										href={`https://www.amazon.com/dp/${book.asin}`}
										target="_blank"
										rel="noopener noreferrer"
										className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition-colors"
									>
										Amazon
									</a>
								)}
							</div>
						</div>
					</div>

					{/* Missing book warning */}
					{!book.hasFile && book.monitored !== false && (
						<div
							className="p-3 rounded-xl flex items-start gap-3"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<AlertTriangle
								className="h-4 w-4 shrink-0 mt-0.5"
								style={{ color: SEMANTIC_COLORS.warning.from }}
							/>
							<p className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
								This book is missing. Click &ldquo;Search&rdquo; to look for it.
							</p>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
