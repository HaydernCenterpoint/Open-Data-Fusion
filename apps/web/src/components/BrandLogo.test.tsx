import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandLogo } from "./BrandLogo";

describe("BrandLogo", () => {
  it("renders the full accessible Open Data Fusion wordmark from four converging paths", () => {
    render(<BrandLogo />);

    const logo = screen.getByRole("img", { name: "Open Data Fusion logo" });
    expect(logo).toHaveClass("brand-logo", "brand-logo--full");
    expect(screen.getByText("Open Data")).toBeVisible();
    expect(screen.getByText("Fusion")).toBeVisible();
    expect(logo.querySelectorAll("path")).toHaveLength(4);
    expect(logo.querySelector("svg")).toHaveAttribute("fill", "none");
  });

  it("renders an icon-only decorative mark for already-labelled controls", () => {
    const { container } = render(<BrandLogo variant="icon" aria-hidden="true" />);

    expect(screen.queryByRole("img", { name: "Open Data Fusion logo" })).not.toBeInTheDocument();
    expect(screen.queryByText("Open Data")).not.toBeInTheDocument();
    expect(container.querySelector(".brand-logo--icon path")).toBeInTheDocument();
  });
});
