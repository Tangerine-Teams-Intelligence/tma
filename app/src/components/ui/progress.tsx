import * as React from "react";
import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number; // 0..100
}

export const Progress = ({ value, className, ...props }: ProgressProps) => (
  <div
    className={cn(
      "relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--ti-border-faint)]",
      className
    )}
    {...props}
  >
    <div
      className="h-full bg-[var(--ti-orange-500)] transition-all duration-fast ease-ti-out"
      style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
    />
  </div>
);
