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

export { Avatar, AvatarFallback, AvatarImage } from "./avatar";
export { Badge, badgeVariants } from "./badge";
export { Button, buttonVariants } from "./button";
export {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "./card";
export { Checkbox } from "./checkbox";
export { Input } from "./input";
export { Label } from "./label";
// Native HTML Select (simple, form-friendly)
export { NativeSelect, SelectOption } from "./native-select";
export { Progress } from "./progress";
export { RadioGroup, RadioGroupItem } from "./radio-group";
// Radix-based Select (complex dropdown with search, groups, etc.)
export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "./select";
export { Separator } from "./separator";
export { Switch } from "./switch";
export { Textarea } from "./textarea";

// ========================================
// Layout Components (shadcn/ui)
// ========================================

export {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "./accordion";
export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
} from "./dialog";
// Legacy Dialog for backward compatibility (supports size prop)
export {
	LegacyDialog,
	LegacyDialogClose,
	LegacyDialogContent,
	LegacyDialogDescription,
	LegacyDialogFooter,
	LegacyDialogHeader,
	LegacyDialogTitle,
} from "./legacy-dialog";

export { Popover, PopoverContent, PopoverTrigger } from "./popover";
export { ScrollArea, ScrollBar } from "./scroll-area";
export {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetOverlay,
	SheetPortal,
	SheetTitle,
	SheetTrigger,
} from "./sheet";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
export {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "./tooltip";

// ========================================
// Data Display (shadcn/ui)
// ========================================

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "./dropdown-menu";
// Legacy DropdownMenu for backward compatibility (trigger prop pattern)
export {
	LegacyDropdownMenu,
	LegacyDropdownMenuDivider,
	LegacyDropdownMenuItem,
} from "./legacy-dropdown-menu";
export {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
} from "./table";

// ========================================
// Feedback (shadcn/ui + custom)
// ========================================

export { Alert, AlertDescription, AlertTitle } from "./alert";
export { Skeleton, SkeletonAvatar, SkeletonCard, SkeletonText } from "./skeleton";

// ========================================
// Forms (shadcn/ui)
// ========================================

export {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	useFormField,
} from "./form";
// Password input with show/hide toggle
export { PasswordInput } from "./password-input";
// Simple form field for non-react-hook-form usage
export { SimpleFormField } from "./simple-form-field";

// ========================================
// Custom Components (arr-dashboard specific)
// ========================================

// Custom components without shadcn equivalents
export { EmptyState, type EmptyStateProps } from "./empty-state";
export { Pagination, type PaginationProps } from "./pagination";
export { StatCard } from "./stat-card";
// Keep custom toast using sonner
export { Toaster, toast } from "./toast";
// Typography
export { Typography } from "./typography";
