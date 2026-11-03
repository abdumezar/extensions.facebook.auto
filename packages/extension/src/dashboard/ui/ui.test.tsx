import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button.js";
import { Checkbox } from "./Checkbox.js";
import { FilterChip, StatusChip } from "./Chip.js";
import { Dialog } from "./Dialog.js";
import { Icon } from "./Icon.js";
import { IconButton } from "./IconButton.js";
import { LinearProgress } from "./LinearProgress.js";
import { SegmentedButton } from "./SegmentedButton.js";
import { Snackbar } from "./Snackbar.js";
import { Switch } from "./Switch.js";
import { NumberField, TextArea, TextField } from "./TextField.js";

describe("Button", () => {
  it("does not fire onClick while disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Start
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button so it cannot submit a surrounding form", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
  });

  it("keeps an explicit type", () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("type", "submit");
  });

  it("hides a decorative icon from assistive tech", () => {
    const { container } = render(<Button icon="add">Add</Button>);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    // The icon must not add a second reading of the control's name.
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("Icon", () => {
  it("exposes an accessible name only when given one", () => {
    const { container, rerender } = render(<Icon name="home" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    rerender(<Icon name="home" label="Home" />);
    expect(screen.getByRole("img", { name: "Home" })).toBeInTheDocument();
  });
});

describe("IconButton", () => {
  it("names itself from the required label", () => {
    render(<IconButton icon="close" label="Close" />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("TextField", () => {
  it("associates the label with the input", () => {
    render(<TextField label="Group ID" />);
    expect(screen.getByLabelText("Group ID")).toBeInTheDocument();
  });

  it("wires supporting text through aria-describedby", () => {
    render(<TextField label="Delay" supportingText="Seconds between posts" />);
    const input = screen.getByLabelText("Delay");
    const descId = input.getAttribute("aria-describedby");
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId!)).toHaveTextContent("Seconds between posts");
  });

  it("marks itself invalid and describes the error", () => {
    render(<TextField label="Group ID" error="Required" />);
    const input = screen.getByLabelText("Group ID");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)).toHaveTextContent(
      "Required",
    );
  });

  it("lets the error replace supporting text rather than showing both", () => {
    render(<TextField label="Group ID" supportingText="Numeric" error="Required" />);
    expect(screen.queryByText("Numeric")).not.toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("keeps a placeholder present so the floating label can track emptiness", () => {
    // The CSS-only float depends on :placeholder-shown; an absent placeholder
    // would silently break the label animation.
    render(<TextField label="Message" />);
    expect(screen.getByLabelText("Message")).toHaveAttribute("placeholder", " ");
  });

  it("is not invalid when there is no error", () => {
    render(<TextField label="Message" />);
    expect(screen.getByLabelText("Message")).not.toHaveAttribute("aria-invalid");
  });

  it("marks required fields visibly and natively", () => {
    render(<TextField label="Group ID" required />);
    const input = screen.getByLabelText(/Group ID/);
    expect(input).toBeRequired();
    // The asterisk is decorative — `required` already carries the semantics.
    expect(document.querySelector("label span[aria-hidden]")).toHaveTextContent("*");
  });

  it("keeps the focus ring — the M3 bottom indicator alone is under 2px perimeter", () => {
    render(<TextField label="Group ID" />);
    expect(screen.getByLabelText("Group ID").className).not.toMatch(/outline-none/);
  });
});

describe("TextArea", () => {
  it("associates its label", () => {
    render(<TextArea label="Post text" />);
    expect(screen.getByLabelText("Post text")).toBeInTheDocument();
  });
});

describe("NumberField", () => {
  it("reports numbers, not strings", async () => {
    const onValueChange = vi.fn();
    render(<NumberField label="Minutes" value={0} onValueChange={onValueChange} />);
    await userEvent.type(screen.getByLabelText("Minutes"), "7");
    expect(onValueChange).toHaveBeenLastCalledWith(7);
  });

  it("substitutes 0 when the field is cleared rather than emitting NaN", async () => {
    const onValueChange = vi.fn();
    render(<NumberField label="Minutes" value={5} onValueChange={onValueChange} />);
    await userEvent.clear(screen.getByLabelText("Minutes"));
    expect(onValueChange).toHaveBeenLastCalledWith(0);
  });

  it("renders 0 instead of a blank when handed a non-finite value", () => {
    render(<NumberField label="Minutes" value={Number.NaN} onValueChange={() => {}} />);
    expect(screen.getByLabelText("Minutes")).toHaveValue(0);
  });
});

describe("Switch", () => {
  it("reports switch semantics and toggles", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} label="Safety break" />);

    const sw = screen.getByRole("switch", { name: "Safety break" });
    expect(sw).toHaveAttribute("aria-checked", "false");

    await userEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle while disabled", async () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} label="Safety" disabled />);
    await userEvent.click(screen.getByRole("switch", { name: "Safety" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("Checkbox", () => {
  it("toggles and reports checked state", async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} label="Select group" />);

    const box = screen.getByRole("checkbox", { name: "Select group" });
    expect(box).not.toBeChecked();

    await userEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does not toggle while disabled", async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onCheckedChange} label="Pick" disabled />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Pick" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("sets the native indeterminate state, and clears it again", () => {
    const { rerender } = render(
      <Checkbox checked={false} indeterminate onCheckedChange={() => {}} label="Page" />,
    );
    const box = screen.getByRole("checkbox", { name: "Page" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    // Assistive tech reads the native property; a duplicate aria-checked would only compete.
    expect(box).not.toHaveAttribute("aria-checked");

    rerender(<Checkbox checked={false} onCheckedChange={() => {}} label="Page" />);
    expect(box.indeterminate).toBe(false);
  });
});

describe("FilterChip", () => {
  it("exposes its selected state", async () => {
    const onSelectedChange = vi.fn();
    render(
      <FilterChip selected onSelectedChange={onSelectedChange}>
        Account A
      </FilterChip>,
    );
    const chip = screen.getByRole("checkbox", { name: /Account A/ });
    expect(chip).toHaveAttribute("aria-checked", "true");

    await userEvent.click(chip);
    expect(onSelectedChange).toHaveBeenCalledWith(false);
  });
});

describe("SegmentedButton", () => {
  const OPTIONS = [
    { value: "range", label: "Range" },
    { value: "fixed", label: "Fixed" },
  ] as const;

  it("marks exactly one segment selected", () => {
    render(
      <SegmentedButton options={OPTIONS} value="fixed" onValueChange={() => {}} label="Delay mode" />,
    );
    expect(screen.getByRole("radio", { name: /Fixed/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Range/ })).toHaveAttribute("aria-checked", "false");
  });

  it("reports the chosen value", async () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedButton
        options={OPTIONS}
        value="range"
        onValueChange={onValueChange}
        label="Delay mode"
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Fixed/ }));
    expect(onValueChange).toHaveBeenCalledWith("fixed");
  });

  // A radiogroup that declares the role but not the keyboard model promises
  // assistive tech an interaction that does not work. These lock it in.
  it("is a single tab stop (roving tabindex)", () => {
    render(
      <SegmentedButton options={OPTIONS} value="range" onValueChange={() => {}} label="Delay mode" />,
    );
    expect(screen.getByRole("radio", { name: /Range/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /Fixed/ })).toHaveAttribute("tabindex", "-1");
  });

  it("moves selection with arrow keys", async () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedButton
        options={OPTIONS}
        value="range"
        onValueChange={onValueChange}
        label="Delay mode"
      />,
    );
    screen.getByRole("radio", { name: /Range/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenCalledWith("fixed");
  });

  it("wraps around at the ends", async () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedButton options={OPTIONS} value="range" onValueChange={onValueChange} label="Delay mode" />,
    );
    screen.getByRole("radio", { name: /Range/ }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onValueChange).toHaveBeenCalledWith("fixed");
  });

  it("supports Home and End", async () => {
    const onValueChange = vi.fn();
    render(
      <SegmentedButton options={OPTIONS} value="fixed" onValueChange={onValueChange} label="Delay mode" />,
    );
    screen.getByRole("radio", { name: /Fixed/ }).focus();
    await userEvent.keyboard("{Home}");
    expect(onValueChange).toHaveBeenCalledWith("range");
  });
});

describe("LinearProgress", () => {
  it("reports a determinate value", () => {
    render(<LinearProgress value={42} label="Success rate" />);
    expect(screen.getByRole("progressbar", { name: "Success rate" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });

  it("clamps out-of-range values", () => {
    render(<LinearProgress value={180} label="Rate" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("omits a value when indeterminate", () => {
    render(<LinearProgress label="Loading" />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });
});

describe("StatusChip", () => {
  it("renders its content", () => {
    render(<StatusChip tone="success">Published</StatusChip>);
    expect(screen.getByText("Published")).toBeInTheDocument();
  });
});

describe("Snackbar", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<Snackbar message={null} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("announces politely rather than interrupting", () => {
    render(<Snackbar message="Failed to load" onDismiss={() => {}} />);
    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("Failed to load");
    expect(bar).toHaveAttribute("aria-live", "polite");
  });

  it("auto-dismisses after the given delay", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<Snackbar message="Saved" onDismiss={onDismiss} durationMs={5000} />);

      vi.advanceTimersByTime(4999);
      expect(onDismiss).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays until dismissed when the duration is 0", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<Snackbar message="Sticky" onDismiss={onDismiss} durationMs={0} />);
      vi.advanceTimersByTime(60_000);
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be dismissed manually", async () => {
    const onDismiss = vi.fn();
    render(<Snackbar message="Oops" onDismiss={onDismiss} dismissLabel="Close" durationMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("Dialog", () => {
  function Harness({ onClose }: { onClose: () => void }) {
    return (
      <Dialog
        open
        onClose={onClose}
        headline="Risky delay"
        actions={
          <>
            <Button variant="text">Post anyway</Button>
            <Button>Apply safe delay</Button>
          </>
        }
      >
        Your delay is too short.
      </Dialog>
    );
  }

  it("exposes modal dialog semantics named by its headline", () => {
    render(<Harness onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Risky delay" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <Dialog open={false} onClose={() => {}} headline="Hidden" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the scrim is clicked", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the panel itself is clicked", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await userEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog on open", () => {
    render(<Harness onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Post anyway" })).toHaveFocus();
  });

  it("wraps Tab from the last control back to the first", async () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByRole("button", { name: "Post anyway" });
    const last = screen.getByRole("button", { name: "Apply safe delay" });

    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
  });

  it("wraps Shift+Tab from the first control to the last", async () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByRole("button", { name: "Post anyway" });
    const last = screen.getByRole("button", { name: "Apply safe delay" });

    first.focus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("marks the app root inert while open and clears it on close", () => {
    // A focus trap only constrains Tab. Without inert, a screen reader's virtual
    // cursor still reaches the page behind the dialog.
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    try {
      const { rerender } = render(<Dialog open onClose={() => {}} headline="Confirm" />);
      expect(root.hasAttribute("inert")).toBe(true);

      rerender(<Dialog open={false} onClose={() => {}} headline="Confirm" />);
      expect(root.hasAttribute("inert")).toBe(false);
    } finally {
      root.remove();
    }
  });

  it("restores focus to the opener when it closes", async () => {
    function Toggle() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Dialog open={open} onClose={() => setOpen(false)} headline="Confirm">
            body
          </Dialog>
        </>
      );
    }

    render(<Toggle />);
    const opener = screen.getByRole("button", { name: "Open" });

    await userEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });
});
