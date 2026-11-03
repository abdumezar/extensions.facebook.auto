import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.js";

function Boom({ explode }: { explode: boolean }): JSX.Element {
  if (explode) throw new Error("render exploded");
  return <p>content</p>;
}

// React logs caught errors to console.error; silence it so a passing run is quiet.
beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("catches a render error instead of blanking the region", () => {
    render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("render exploded")).toBeInTheDocument();
  });

  it("offers a recovery path rather than a dead end", async () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Retry clears the error; the child renders again once it stops throwing.
    rerender(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    await userEvent.click(screen.getByRole("button"));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("resets itself when the view changes", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="groups">
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Navigating away must not strand the user on another page's error.
    rerender(
      <ErrorBoundary resetKey="settings">
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
