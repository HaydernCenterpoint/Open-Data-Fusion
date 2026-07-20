import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthBoundary } from "./AuthBoundary";

const authMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("../lib/auth", () => authMocks);

describe("factory AuthBoundary", () => {
  beforeEach(() => {
    authMocks.initialize.mockReset();
    authMocks.signIn.mockReset();
    authMocks.signOut.mockReset();
  });

  it("renders the workspace immediately for a shared session", async () => {
    authMocks.initialize.mockResolvedValue({
      enabled: true,
      authenticated: true,
      identity: { userId: "factory.user", displayName: "Factory User" },
    });
    render(<AuthBoundary><div>Factory workspace</div></AuthBoundary>);

    expect(await screen.findByText("Factory workspace")).toBeInTheDocument();
    expect(screen.queryByText("Sign in to Open Data Fusion")).not.toBeInTheDocument();
  });

  it("shows the sign-in action when the main session is absent", async () => {
    authMocks.initialize.mockResolvedValue({ enabled: true, authenticated: false, identity: null });
    render(<AuthBoundary><div>Factory workspace</div></AuthBoundary>);

    expect(await screen.findByText("Sign in to Open Data Fusion")).toBeInTheDocument();
    expect(screen.queryByText("Factory workspace")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to sign in" }));
    expect(authMocks.signIn).toHaveBeenCalledTimes(1);
  });
});
