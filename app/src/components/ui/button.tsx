import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-fast ease-ti-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ti-orange-500)] text-white hover:bg-[var(--ti-orange-600)] active:bg-[var(--ti-orange-700)]",
        outline:
          "border border-[var(--ti-border-default)] bg-transparent text-[var(--ti-ink-900)] hover:bg-[var(--ti-paper-200)]",
        ghost: "bg-transparent text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]",
        destructive: "bg-[var(--ti-danger)] text-white hover:opacity-90",
        link: "text-[var(--ti-orange-500)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
);
Button.displayName = "Button";

export { buttonVariants };
