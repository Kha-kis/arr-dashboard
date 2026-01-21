"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useThemeGradient } from "../../hooks/useThemeGradient"

/**
 * Premium Table Container
 *
 * Glassmorphic table wrapper with rounded corners and subtle border.
 */
const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-hidden rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs">
    <div className="overflow-auto">
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  </div>
))
Table.displayName = "Table"

/**
 * Premium Table Header
 *
 * Subtle background with theme-aware styling.
 */
const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      "border-b border-border/50 bg-muted/30",
      "[&_tr]:border-b-0",
      className
    )}
    {...props}
  />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "border-t border-border/50 bg-muted/20 font-medium last:[&>tr]:border-b-0",
      className
    )}
    {...props}
  />
))
TableFooter.displayName = "TableFooter"

interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Enable theme-aware hover effect */
  premium?: boolean
  /** Show selection indicator on left edge */
  isSelected?: boolean
}

/**
 * Premium Table Row
 *
 * Row with optional theme-aware hover gradient and selection indicator.
 */
const TableRow = React.forwardRef<HTMLTableRowElement, TableRowProps>(
  ({ className, premium = false, isSelected = false, ...props }, ref) => {
    const { gradient: themeGradient } = useThemeGradient()

    return (
      <tr
        ref={ref}
        className={cn(
          "group relative border-b border-border/30 last:border-0",
          "transition-colors duration-200",
          // Standard hover
          !premium && "hover:bg-muted/50 data-[state=selected]:bg-muted",
          // Premium has custom hover via pseudo-element
          premium && "hover:bg-transparent",
          className
        )}
        {...props}
      >
        {/* Premium hover gradient overlay */}
        {premium && (
          <td className="absolute inset-0 pointer-events-none p-0 border-0">
            <div
              className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              style={{
                background: `linear-gradient(90deg, ${themeGradient.fromLight}, transparent)`,
              }}
            />
          </td>
        )}

        {/* Selection indicator */}
        {isSelected && (
          <td className="absolute left-0 top-0 bottom-0 w-1 p-0 border-0 pointer-events-none">
            <div
              className="h-full w-full"
              style={{
                background: `linear-gradient(180deg, ${themeGradient.from}, ${themeGradient.to})`,
              }}
            />
          </td>
        )}

        {props.children}
      </tr>
    )
  }
)
TableRow.displayName = "TableRow"

/**
 * Premium Table Head Cell
 *
 * Header cell with refined typography.
 */
const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-11 px-4 text-left align-middle",
      "text-xs font-medium text-muted-foreground uppercase tracking-wide",
      "[&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
))
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "p-4 align-middle [&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("py-4 text-sm text-muted-foreground", className)}
    {...props}
  />
))
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
export type { TableRowProps }
