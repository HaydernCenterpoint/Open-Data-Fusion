import { useId } from "react";
import type { ComponentPropsWithoutRef } from "react";

export type BrandLogoVariant = "full" | "icon";

interface BrandLogoProps extends ComponentPropsWithoutRef<"span"> {
  variant?: BrandLogoVariant;
}

export function BrandLogo({
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  className,
  variant = "full",
  ...props
}: BrandLogoProps) {
  const gradientPrefix = useId().replace(/:/gu, "");
  const hidden = ariaHidden === true || ariaHidden === "true";
  const classes = ["brand-logo", `brand-logo--${variant}`, className].filter(Boolean).join(" ");

  return (
    <span
      {...props}
      aria-hidden={ariaHidden}
      aria-label={hidden ? undefined : ariaLabel ?? "Open Data Fusion logo"}
      className={classes}
      role={hidden ? undefined : "img"}
    >
      <svg className="brand-logo__icon" viewBox="0 0 160 136" fill="none" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${gradientPrefix}-blue`} x1="33" x2="139" y1="17" y2="76" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1748ec" />
            <stop offset="1" stopColor="#2a9fec" />
          </linearGradient>
          <linearGradient id={`${gradientPrefix}-teal`} x1="33" x2="139" y1="50" y2="75" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00aa98" />
            <stop offset="1" stopColor="#00c3a8" />
          </linearGradient>
          <linearGradient id={`${gradientPrefix}-sky`} x1="33" x2="139" y1="83" y2="65" gradientUnits="userSpaceOnUse">
            <stop stopColor="#16a8ed" />
            <stop offset="1" stopColor="#00b7d9" />
          </linearGradient>
          <linearGradient id={`${gradientPrefix}-navy`} x1="33" x2="139" y1="116" y2="65" gradientUnits="userSpaceOnUse">
            <stop stopColor="#081a3d" />
            <stop offset="1" stopColor="#145d87" />
          </linearGradient>
          <linearGradient id={`${gradientPrefix}-fusion`} x1="113" x2="158" y1="42" y2="94" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00c4aa" />
            <stop offset="1" stopColor="#00a890" />
          </linearGradient>
        </defs>
        <path d="M42 17H72C88 17 92 24 100 38L116 62C122 71 130 74 139 74" stroke={`url(#${gradientPrefix}-blue)`} strokeWidth="7" strokeLinecap="round" />
        <path d="M42 50H75C88 50 92 55 101 64C110 73 121 76 139 75" stroke={`url(#${gradientPrefix}-teal)`} strokeWidth="7" strokeLinecap="round" />
        <path d="M42 83H75C88 83 92 78 101 70C110 62 120 61 139 65" stroke={`url(#${gradientPrefix}-sky)`} strokeWidth="7" strokeLinecap="round" />
        <path d="M42 116H75C88 116 91 109 99 95L113 76C120 66 127 64 139 64" stroke={`url(#${gradientPrefix}-navy)`} strokeWidth="7" strokeLinecap="round" />
        <circle cx="22" cy="17" r="11" fill={`url(#${gradientPrefix}-blue)`} />
        <circle cx="22" cy="50" r="11" fill={`url(#${gradientPrefix}-teal)`} />
        <circle cx="22" cy="83" r="11" fill={`url(#${gradientPrefix}-sky)`} />
        <circle cx="22" cy="116" r="11" fill={`url(#${gradientPrefix}-navy)`} />
        <circle cx="137" cy="69" r="22" fill={`url(#${gradientPrefix}-fusion)`} />
        <circle cx="137" cy="69" r="8" fill="var(--brand-logo-cutout, #fff)" />
      </svg>
      {variant === "full" ? (
        <span className="brand-logo__wordmark" aria-hidden="true">
          <span className="brand-logo__open">Open Data</span>
          <span className="brand-logo__fusion">Fusion</span>
        </span>
      ) : null}
    </span>
  );
}
