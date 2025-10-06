/**
 * UI Component Library - Public API
 *
 * Centralized exports for all UI primitives.
 * Import components from here rather than individual files.
 *
 * @example
 * import { Button, Badge, Dialog } from '@/components/ui';
 */

// Primitives
export { Button, type ButtonProps } from "./button";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./card";
export { Input, type InputProps } from "./input";
export { Badge, type BadgeProps } from "./badge";
export {
  Select,
  SelectOption,
  type SelectProps,
  type SelectOptionProps,
} from "./select";
export {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogContent,
  DialogFooter,
  type DialogProps,
  type DialogHeaderProps,
  type DialogTitleProps,
  type DialogDescriptionProps,
  type DialogContentProps,
  type DialogFooterProps,
} from "./dialog";

// Feedback Components
export { Toaster, toast } from "./toast";
export { Alert, AlertTitle, AlertDescription, type AlertProps } from "./alert";
export { EmptyState, type EmptyStateProps } from "./empty-state";

// Loading States
export {
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonAvatar,
} from "./skeleton";
