import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GroupsIncompleteNotice } from "./GroupsIncompleteNotice.js";

/** Translations are absent under test, so the assertions are about which key is chosen. */
describe("GroupsIncompleteNotice", () => {
  it("says the rest loads by itself for the current session", () => {
    render(<GroupsIncompleteNotice count={910} automatic />);
    expect(screen.getByRole("status")).toHaveTextContent("groups.incompleteAuto");
  });

  it("tells a managed account to press refresh for the next batch", () => {
    render(<GroupsIncompleteNotice count={910} automatic={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("groups.incompleteManual");
  });
});
