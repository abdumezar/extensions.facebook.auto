import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { i18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION, type Group } from "@nashir/shared";
import { createTestI18n } from "../../test/i18n.js";
import { useStore } from "../store.js";
import { GroupsPage } from "./GroupsPage.js";

vi.mock("../lib/data.js", () => ({
  loadCachedGroups: vi.fn(async () => null),
  reloadGroups: vi.fn(async () => []),
  previewLeaveGroup: vi.fn(),
  leaveGroups: vi.fn(),
}));
vi.mock("../components/GroupDiscovery.js", () => ({ GroupDiscovery: () => null }));

const PAGE_SIZE_KEY = "nashir:groups:pageSize";

let i18n: i18n;
beforeAll(async () => {
  i18n = await createTestI18n();
});

/** Synthetic groups "Group 001"… with a numeric id each. */
function makeGroups(count: number): Group[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(1000 + i),
    name: `Group ${String(i + 1).padStart(3, "0")}`,
    memberCount: 10 + i,
  }));
}

function setGroups(groups: Group[]) {
  act(() => useStore.setState({ groups }));
}

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <GroupsPage />
    </I18nextProvider>,
  );
}

/** Body rows only, as [# cell, name cell] text pairs. */
function rows(): { num: string; name: string }[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => ({
      num: (r as HTMLTableRowElement).cells[0]!.textContent ?? "",
      name: within(r).getByRole("rowheader").querySelector("bdi")!.textContent ?? "",
    }));
}

/** Pagination text is split across elements (numbers are isolated), so match the whole block. */
const announced = (text: string) =>
  screen.getByText((_, el) => el?.getAttribute("aria-live") === "polite" && el.textContent === text);

const headerBox = () => screen.getByRole("checkbox", { name: "Select the groups on this page" }) as HTMLInputElement;
// No inter-action delay: the default 0 ms timer per event adds up over 120-row tables.
const user = userEvent.setup({ delay: null });
const click = (name: string | RegExp) => user.click(screen.getByRole("button", { name }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });
  document.documentElement.setAttribute("dir", "ltr");
  useStore.setState({
    accounts: [],
    activeAccountId: CURRENT_SESSION,
    groups: [],
    groupsSyncedAt: 0,
    groupsIncomplete: false,
    selectedGroupIds: new Set(),
  });
});

afterEach(() => {
  cleanup();
  // jsdom has no scrollIntoView; the test that needs one installs it.
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
});

describe("GroupsPage pagination", () => {
  it("shows 50 rows of a 120-group list, with the range and page count", () => {
    setGroups(makeGroups(120));
    renderPage();

    expect(rows()).toHaveLength(50);
    expect(rows()[0]).toEqual({ num: "1", name: "Group 001" });
    expect(announced("1–50 of 120")).toBeInTheDocument();
    expect(announced("Page 1 of 3")).toBeInTheDocument();
  });

  it("numbers rows by position in the filtered list on later pages", async () => {
    setGroups(makeGroups(120));
    renderPage();

    await click("Next page");
    expect(rows()).toHaveLength(50);
    expect(rows()[0]).toEqual({ num: "51", name: "Group 051" });
    expect(rows()[49]).toEqual({ num: "100", name: "Group 100" });
    expect(announced("51–100 of 120")).toBeInTheDocument();

    await click("Last page");
    expect(rows()).toHaveLength(20);
    expect(announced("101–120 of 120")).toBeInTheDocument();
  });

  it("goes back to page 1 when the search changes", async () => {
    setGroups(makeGroups(120));
    renderPage();
    await click("Next page");
    expect(announced("Page 2 of 3")).toBeInTheDocument();

    // Every name matches, so the page count is unchanged: only the reset explains page 1.
    await user.type(screen.getByRole("searchbox"), "group");
    expect(announced("Page 1 of 3")).toBeInTheDocument();
    expect(rows()[0]!.num).toBe("1");
  });

  it("clamps to the last page when rows disappear from under it", async () => {
    setGroups(makeGroups(120));
    renderPage();
    await click("Last page");
    expect(announced("Page 3 of 3")).toBeInTheDocument();

    // A background batch, or a leave, shrinks the list: page 3 no longer exists.
    setGroups(makeGroups(60));
    expect(announced("Page 2 of 2")).toBeInTheDocument();
    expect(rows()).toHaveLength(10);
    expect(rows()[0]!.num).toBe("51");
  });

  it("returns to page 1 when the account changes", async () => {
    useStore.setState({ accounts: [{ id: "acc-b", label: "Account B" } as never] });
    setGroups(makeGroups(120));
    renderPage();
    await click("Next page");
    expect(announced("Page 2 of 3")).toBeInTheDocument();

    act(() => useStore.getState().setActiveAccount("acc-b"));
    expect(announced("Page 1 of 3")).toBeInTheDocument();
  });

  it("changes the page size and remembers it", async () => {
    setGroups(makeGroups(120));
    const { unmount } = renderPage();

    await user.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "25");
    expect(rows()).toHaveLength(25);
    expect(announced("Page 1 of 5")).toBeInTheDocument();
    expect(localStorage.getItem(PAGE_SIZE_KEY)).toBe("25");

    unmount();
    renderPage();
    expect(rows()).toHaveLength(25);
  });

  it("falls back to 50 when the stored page size is not an offered one", () => {
    localStorage.setItem(PAGE_SIZE_KEY, "7");
    setGroups(makeGroups(120));
    renderPage();
    expect(rows()).toHaveLength(50);
  });

  it("still works when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setGroups(makeGroups(120));
    renderPage();
    expect(rows()).toHaveLength(50);

    await user.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "100");
    expect(rows()).toHaveLength(100);
  });
});

describe("GroupsPage page navigation", () => {
  it("scrolls the top of the table into view when the page changes", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    setGroups(makeGroups(120));
    renderPage();
    expect(scrollIntoView).not.toHaveBeenCalled();

    await click("Next page");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const scrolled = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(scrolled.contains(screen.getByRole("table"))).toBe(true);
    expect(scrolled).not.toBe(document.body);
  });

  it("passes the page direction on, so the arrows point the right way in Arabic", () => {
    setGroups(makeGroups(120));
    const pathOf = (name: string) => screen.getByRole("button", { name }).querySelector("path")?.getAttribute("d");

    const ltr = renderPage();
    const [ltrPrev, ltrNext] = [pathOf("Previous page"), pathOf("Next page")];
    ltr.unmount();

    document.documentElement.setAttribute("dir", "rtl");
    renderPage();
    expect(ltrPrev).not.toBe(ltrNext);
    expect(pathOf("Previous page")).toBe(ltrNext);
    expect(pathOf("Next page")).toBe(ltrPrev);
  });

  it("formats counts with the language's grouping", () => {
    setGroups(makeGroups(1234));
    renderPage();
    expect(screen.getByRole("button", { name: "Select all matching (1,234)" })).toBeInTheDocument();
  });
});

describe("GroupsPage selection across pages", () => {
  it("selects every matching group, not only the page shown", async () => {
    setGroups(makeGroups(120));
    renderPage();

    await click("Select all matching (120)");
    expect(useStore.getState().selectedGroupIds.size).toBe(120);

    await click("Deselect all matching");
    expect(useStore.getState().selectedGroupIds.size).toBe(0);
  });

  it("limits select-all-matching to the search results", async () => {
    setGroups(makeGroups(120));
    renderPage();
    // "Group 01" matches 010–019 only.
    await user.type(screen.getByRole("searchbox"), "Group 01");

    await click("Select all matching (10)");
    expect(useStore.getState().selectedGroupIds.size).toBe(10);
  });

  it("header checkbox toggles only the current page", async () => {
    setGroups(makeGroups(120));
    renderPage();

    await user.click(headerBox());
    expect(useStore.getState().selectedGroupIds.size).toBe(50);
    expect(headerBox().checked).toBe(true);

    await click("Next page");
    // Nothing on page 2 is selected yet, so the box starts clear again.
    expect(headerBox().checked).toBe(false);
    expect(headerBox().indeterminate).toBe(false);

    await user.click(headerBox());
    expect(useStore.getState().selectedGroupIds.size).toBe(100);

    // Clearing page 2 leaves page 1's selection alone.
    await user.click(headerBox());
    expect(useStore.getState().selectedGroupIds.size).toBe(50);
  });

  it("shows the header checkbox as mixed when only some of the page is selected", async () => {
    setGroups(makeGroups(120));
    renderPage();

    await user.click(screen.getByRole("checkbox", { name: "Group 003" }));
    expect(headerBox().indeterminate).toBe(true);
    expect(headerBox().checked).toBe(false);

    // From mixed, one click selects the rest of the page.
    await user.click(headerBox());
    expect(useStore.getState().selectedGroupIds.size).toBe(50);
    expect(headerBox().indeterminate).toBe(false);
    expect(headerBox().checked).toBe(true);
  });

  it("keeps the selection when paging away and back", async () => {
    setGroups(makeGroups(120));
    renderPage();
    await user.click(screen.getByRole("checkbox", { name: "Group 003" }));

    await click("Next page");
    await click("Previous page");
    expect(screen.getByRole("checkbox", { name: "Group 003" })).toBeChecked();
    expect(screen.getByText("1 of 120 selected")).toBeInTheDocument();
  });

  it("flags the leave dialog when the selection reaches beyond the current page", async () => {
    setGroups(makeGroups(120));
    renderPage();
    await click("Select all matching (120)");

    await click(/Leave 120 selected/);
    expect(screen.getByText("120 groups in total will be left.")).toBeInTheDocument();
    expect(screen.getByText("This includes groups on other pages or hidden by your search.")).toBeInTheDocument();
  });

  it("leaves out the other-pages note when everything selected is on the page", async () => {
    setGroups(makeGroups(120));
    renderPage();
    await user.click(headerBox());

    await click(/Leave 50 selected/);
    expect(screen.getByText("50 groups in total will be left.")).toBeInTheDocument();
    expect(screen.queryByText(/other pages/)).not.toBeInTheDocument();
  });
});
