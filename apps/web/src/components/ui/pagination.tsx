"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "./button";
import { Select, SelectOption } from "./select";

export interface PaginationProps {
	/**
	 * Current page number (1-indexed)
	 */
	currentPage: number;
	/**
	 * Total number of items across all pages
	 */
	totalItems: number;
	/**
	 * Number of items per page
	 */
	pageSize: number;
	/**
	 * Callback when page changes
	 */
	onPageChange: (page: number) => void;
	/**
	 * Callback when page size changes
	 */
	onPageSizeChange: (pageSize: number) => void;
	/**
	 * Available page size options
	 */
	pageSizeOptions?: number[];
	/**
	 * Maximum number of page buttons to show
	 */
	maxPageButtons?: number;
}

export const Pagination = ({
	currentPage,
	totalItems,
	pageSize,
	onPageChange,
	onPageSizeChange,
	pageSizeOptions = [25, 50, 100],
	maxPageButtons = 7,
}: PaginationProps) => {
	const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
	const startItem = Math.min((currentPage - 1) * pageSize + 1, totalItems);
	const endItem = Math.min(currentPage * pageSize, totalItems);

	// Calculate which page numbers to show
	const getPageNumbers = (): number[] => {
		if (totalPages <= maxPageButtons) {
			return Array.from({ length: totalPages }, (_, i) => i + 1);
		}

		const half = Math.floor(maxPageButtons / 2);
		let start = Math.max(1, currentPage - half);
		let end = Math.min(totalPages, start + maxPageButtons - 1);

		// Adjust if we're near the end
		if (end - start < maxPageButtons - 1) {
			start = Math.max(1, end - maxPageButtons + 1);
		}

		const pages: number[] = [];
		for (let i = start; i <= end; i++) {
			pages.push(i);
		}

		return pages;
	};

	const pageNumbers = getPageNumbers();
	const showFirstPage = pageNumbers[0] > 1;
	const showLastPage = pageNumbers[pageNumbers.length - 1] < totalPages;

	if (totalItems === 0) {
		return null;
	}

	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
			{/* Items info and page size selector */}
			<div className="flex flex-wrap items-center gap-4 text-sm text-white/70">
				<span>
					Showing <span className="font-medium text-white">{startItem}</span> to{" "}
					<span className="font-medium text-white">{endItem}</span> of{" "}
					<span className="font-medium text-white">{totalItems}</span> items
				</span>
				<div className="flex items-center gap-2">
					<label htmlFor="page-size" className="text-sm">
						Per page:
					</label>
					<Select
						id="page-size"
						value={pageSize}
						onChange={(e) => onPageSizeChange(Number(e.target.value))}
						className="w-20 py-1 text-sm"
					>
						{pageSizeOptions.map((size) => (
							<SelectOption key={size} value={size}>
								{size}
							</SelectOption>
						))}
					</Select>
				</div>
			</div>

			{/* Page navigation */}
			<div className="flex items-center gap-1">
				{/* First page button */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onPageChange(1)}
					disabled={currentPage === 1}
					title="First page"
					className="h-8 w-8 p-0"
				>
					<ChevronsLeft className="h-4 w-4" />
				</Button>

				{/* Previous page button */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onPageChange(currentPage - 1)}
					disabled={currentPage === 1}
					title="Previous page"
					className="h-8 w-8 p-0"
				>
					<ChevronLeft className="h-4 w-4" />
				</Button>

				{/* First page number if not in range */}
				{showFirstPage && (
					<>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPageChange(1)}
							className="h-8 min-w-[2rem] px-2"
						>
							1
						</Button>
						{pageNumbers[0] > 2 && (
							<span className="px-2 text-white/50">...</span>
						)}
					</>
				)}

				{/* Page number buttons */}
				{pageNumbers.map((pageNum) => (
					<Button
						key={pageNum}
						variant={pageNum === currentPage ? "primary" : "ghost"}
						size="sm"
						onClick={() => onPageChange(pageNum)}
						className="h-8 min-w-[2rem] px-2"
					>
						{pageNum}
					</Button>
				))}

				{/* Last page number if not in range */}
				{showLastPage && (
					<>
						{pageNumbers[pageNumbers.length - 1] < totalPages - 1 && (
							<span className="px-2 text-white/50">...</span>
						)}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onPageChange(totalPages)}
							className="h-8 min-w-[2rem] px-2"
						>
							{totalPages}
						</Button>
					</>
				)}

				{/* Next page button */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onPageChange(currentPage + 1)}
					disabled={currentPage === totalPages}
					title="Next page"
					className="h-8 w-8 p-0"
				>
					<ChevronRight className="h-4 w-4" />
				</Button>

				{/* Last page button */}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onPageChange(totalPages)}
					disabled={currentPage === totalPages}
					title="Last page"
					className="h-8 w-8 p-0"
				>
					<ChevronsRight className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
};
