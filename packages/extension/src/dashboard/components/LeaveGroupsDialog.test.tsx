import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Group, GroupLeavePreview } from "@nashir/shared";
import { LeaveGroupsDialog } from "./LeaveGroupsDialog.js";

const previewLeaveGroup = vi.fn();
const leaveGroups = vi.fn();
vi.mock("../lib/data.js", () => ({
  previewLeaveGroup: (...args: unknown[]) => previewLeaveGroup(...args),
  leaveGroups: (...args: unknown[]) => leaveGroups(...args),
}));

// Without an i18next instance `t` returns the key, so assertions target keys.
afterEach(() => vi.clearAllMocks());

const OWN: Group = { id: "111111", name: "My Own Group" };
const OTHER: Group = { id: "222222", name: "Someone Else's Group" };

function quietPreview(over: Partial<GroupLeavePreview> = {}): GroupLeavePreview {
  return { groupId: "111111", deletesGroupWhenLastMemberLeaves: false, canDelete: false, ...over };
}

function renderDialog(targets: Group[], onDone = vi.fn(), onClose = vi.fn()) {
  render(
    <LeaveGroupsDialog accountId="acc" targets={targets} onClose={onClose} onDone={onDone} />,
  );
  return { onDone, onClose };
}

describe("LeaveGroupsDialog", () => {
  it("will not leave until Facebook's warning check has resolved", async () => {
    let resolve: (p: GroupLeavePreview) => void = () => {};
    previewLeaveGroup.mockReturnValue(new Promise<GroupLeavePreview>((r) => (resolve = r)));
    renderDialog([OWN]);

    const confirm = screen.getByRole("button", { name: "leave.confirm" });
    expect(confirm).toBeDisabled();
    expect(screen.getByText("leave.checking")).toBeInTheDocument();

    resolve(quietPreview());
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(leaveGroups).not.toHaveBeenCalled();
  });

  it("shows Facebook's delete warning when it offers an outright delete", async () => {
    previewLeaveGroup.mockResolvedValue(quietPreview({ canDelete: true, confirmationTitle: "Are you sure?" }));
    renderDialog([OWN]);

    expect(await screen.findByText("leave.deleteWarning")).toBeInTheDocument();
    // Facebook's own headline wins over our generic one.
    expect(screen.getByRole("heading", { name: "Are you sure?" })).toBeInTheDocument();
    // The softer last-member note would be redundant next to it.
    expect(screen.queryByText("leave.lastMemberNote")).not.toBeInTheDocument();
  });

  it("notes the last-member rule for a group Facebook will not let us delete outright", async () => {
    previewLeaveGroup.mockResolvedValue(quietPreview({ deletesGroupWhenLastMemberLeaves: true }));
    renderDialog([OTHER]);

    expect(await screen.findByText("leave.lastMemberNote")).toBeInTheDocument();
    expect(screen.queryByText("leave.deleteWarning")).not.toBeInTheDocument();
  });

  it("still allows leaving when the warning check itself fails", async () => {
    previewLeaveGroup.mockRejectedValue(new Error("doc_id rotated"));
    leaveGroups.mockResolvedValue([{ groupId: "111111", outcome: "left" }]);
    const { onDone, onClose } = renderDialog([OWN]);

    expect(await screen.findByText("doc_id rotated")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "leave.confirm" });
    await waitFor(() => expect(confirm).toBeEnabled());

    await userEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith([{ groupId: "111111", outcome: "left" }]));
    expect(leaveGroups).toHaveBeenCalledWith("acc", ["111111"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("warns about deletion for a batch without previewing every group", async () => {
    leaveGroups.mockResolvedValue([]);
    renderDialog([OWN, OTHER]);

    expect(screen.getByText("leave.manyWarning")).toBeInTheDocument();
    expect(previewLeaveGroup).not.toHaveBeenCalled();
    expect(screen.getByText(OWN.name)).toBeInTheDocument();
    expect(screen.getByText(OTHER.name)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "leave.confirmMany" }));
    await waitFor(() => expect(leaveGroups).toHaveBeenCalledWith("acc", ["111111", "222222"]));
  });

  it("keeps the dialog open and reports the error when the leave fails", async () => {
    previewLeaveGroup.mockResolvedValue(quietPreview());
    leaveGroups.mockRejectedValue(new Error("Rate limited"));
    const { onDone, onClose } = renderDialog([OWN]);

    const confirm = screen.getByRole("button", { name: "leave.confirm" });
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    expect(await screen.findByText("Rate limited")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
