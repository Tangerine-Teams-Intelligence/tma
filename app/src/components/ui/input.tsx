import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-md border bg-[var(--ti-paper-50)] px-3 py-2 text-sm text-[var(--ti-ink-900)] placeholder:text-[var(--ti-ink-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
        invalid
          ? "border-[var(--ti-danger)] focus-visible:ring-[var(--ti-danger)]"
          : "border-[var(--ti-border-default)]",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
