/**
 * UI Component Library - Public API
 *
 * shadcn/ui components with custom extensions.
 * Import components from here rather than individual files.
 *
 * @example
 * import { Button, Badge, Dialog } from '@/components/ui';
 */

// ========================================
// Core Components (shadcn/ui)
// ========================================

export { Button, buttonVariants } from "./button";
export {
	Card,
	CardHeader,
	CardFooter,
	CardTitle,
	CardDescription,
	CardContent,
} from "./card";
export { Input } from "./input";
export { Textarea } from "./textarea";
export { Label } from "./label";
export { Badge, badgeVariants } from "./badge";
export { Checkbox } from "./checkbox";
export { Switch } from "./switch";

// Radix-based Select (complex dropdown with search, groups, etc.)
export {
	Select,
	SelectGroup,
	SelectValue,
	SelectTrigger,
	SelectContent,
	SelectLabel,
	SelectItem,
	SelectSeparator,
	SelectScrollUpButton,
	SelectScrollDownButton,
} from "./select";

// Native HTML Select (simple, form-friendly)
export { NativeSelect, SelectOption } from "./native-select";

export { RadioGroup, RadioGroupItem } from "./radio-group";
export { Separator } from "./separator";
export { Progress } from "./progress";
export { Avatar, AvatarImage, AvatarFallback } from "./avatar";

// ========================================
// Layout Components (shadcn/ui)
// ========================================

export {
	Dialog,
	DialogPortal,
	DialogOverlay,
	DialogTrigger,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "./dialog";

// Legacy Dialog for backward compatibility (supports size prop)
export {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
	LegacyDialogClose,
} from "./legacy-dialog";

export {
	Sheet,
	SheetPortal,
	SheetOverlay,
	SheetTrigger,
	SheetClose,
	SheetContent,
	SheetHeader,
	SheetFooter,
	SheetTitle,
	SheetDescription,
} from "./sheet";

export { Popover, PopoverTrigger, PopoverContent } from "./popover";

export {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipProvider,
} from "./tooltip";

export { ScrollArea, ScrollBar } from "./scroll-area";

export {
	Accordion,
	AccordionItem,
	AccordionTrigger,
	AccordionContent,
} from "./accordion";

export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

// ========================================
// Data Display (shadcn/ui)
// ========================================

export {
	Table,
	TableHeader,
	TableBody,
	TableFooter,
	TableHead,
	TableRow,
	TableCell,
	TableCaption,
} from "./table";

export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuGroup,
	DropdownMenuPortal,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuRadioGroup,
} from "./dropdown-menu";

// Legacy DropdownMenu for backward compatibility (trigger prop pattern)
export {
	LegacyDropdownMenu,
	LegacyDropdownMenuItem,
	LegacyDropdownMenuDivider,
} from "./legacy-dropdown-menu";

// ========================================
// Feedback (shadcn/ui + custom)
// ========================================

export { Alert, AlertTitle, AlertDescription } from "./alert";
export { Skeleton, SkeletonText, SkeletonCard, SkeletonAvatar } from "./skeleton";

// ========================================
// Forms (shadcn/ui)
// ========================================

export {
	useFormField,
	Form,
	FormItem,
	FormLabel,
	FormControl,
	FormDescription,
	FormMessage,
	FormField,
} from "./form";

// Simple form field for non-react-hook-form usage
export { SimpleFormField } from "./simple-form-field";

// ========================================
// Custom Components (arr-dashboard specific)
// ========================================

// Keep custom toast using sonner
export { Toaster, toast } from "./toast";

// Typography
export { Typography } from "./typography";

// Custom components without shadcn equivalents
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Pagination, type PaginationProps } from "./pagination";
export { StatCard } from "./stat-card";
