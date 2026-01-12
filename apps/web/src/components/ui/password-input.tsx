"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /**
   * Whether to show the toggle button (default: true)
   */
  showToggle?: boolean;
}

/**
 * Password input with show/hide toggle
 *
 * A styled password input that includes an optional visibility toggle button.
 * Uses the same styling as the Input component for consistency.
 *
 * @example
 * ```tsx
 * <PasswordInput
 *   id="password"
 *   placeholder="Enter password"
 *   value={password}
 *   onChange={(e) => setPassword(e.target.value)}
 * />
 * ```
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, showToggle = true, disabled, ...props }, ref) => {
    const [showPassword, setShowPassword] = React.useState(false);

    return (
      <div className="relative">
        <input
          type={showPassword ? "text" : "password"}
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            showToggle && "pr-10",
            className
          )}
          ref={ref}
          disabled={disabled}
          {...props}
        />
        {showToggle && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
            onClick={() => setShowPassword((prev) => !prev)}
            disabled={disabled}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
    );
  }
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
