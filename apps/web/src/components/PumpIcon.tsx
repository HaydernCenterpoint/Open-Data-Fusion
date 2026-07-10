import type { LucideProps } from "lucide-react";
import { forwardRef } from "react";

export const PumpIcon = forwardRef<SVGSVGElement, LucideProps>(function PumpIcon(
  { size = 24, strokeWidth = 1.5, ...props },
  ref,
) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      ref={ref}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      {...props}
    >
      <path d="M7 6.5h8v11H7z" />
      <path d="M10 3.5h3v3" />
      <path d="M15 10h2a3 3 0 0 1 0 6h-2" />
      <path d="M4 9h3v7H4" />
      <path d="M5.5 20.5h12" />
      <path d="M8.5 17.5v3M14 17.5v3" />
    </svg>
  );
});

PumpIcon.displayName = "PumpIcon";
