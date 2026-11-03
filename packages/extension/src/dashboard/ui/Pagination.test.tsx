import { render, screen, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { i18n } from "i18next";
import { createTestI18n } from "../../test/i18n.js";
import { Pagination, type PaginationProps } from "./Pagination.js";

let i18n: i18n;
let i18nAr: i18n;
beforeAll(async () => {
  i18n = await createTestI18n("en");
  i18nAr = await createTestI18n("ar");
});

function renderPagination(over: Partial<PaginationProps> = {}) {
  const props: PaginationProps = {
    page: 2,
    pageCount: 5,
    total: 230,
    pageSize: 50,
    dir: "ltr",
    onPageChange: vi.fn(),
    ...over,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <Pagination {...props} />
    </I18nextProvider>,
  );
  return props;
}

describe("Pagination", () => {
  /** The two announced text blocks: the range and the page count. */
  const liveRegions = () => Array.from(document.querySelectorAll<HTMLElement>("[aria-live=polite]"));

  it("shows the range and the page count", () => {
    renderPagination();
    const [range, pages] = liveRegions();
    expect(range).toHaveTextContent("51–100 of 230");
    expect(pages).toHaveTextContent("Page 2 of 5");
  });

  it("clips the range to the total on the last page", () => {
    renderPagination({ page: 5 });
    expect(liveRegions()[0]).toHaveTextContent("201–230 of 230");
  });

  it("is a labelled navigation landmark whose text is announced politely", () => {
    renderPagination();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeInTheDocument();
    expect(liveRegions()).toHaveLength(2);
  });

  it("isolates only the numbers, leaving the words in the page direction", () => {
    renderPagination({ page: 1, pageCount: 25, total: 1234, pageSize: 50 });
    const [range, pages] = liveRegions();
    const isolated = (el: HTMLElement) => within(el).queryAllByText(/\d/, { selector: "bdi" });

    expect(isolated(range!).map((b) => b.textContent)).toEqual(["1–50", "1,234"]);
    expect(isolated(range!).every((b) => b.getAttribute("dir") === "ltr")).toBe(true);
    expect(isolated(pages!).map((b) => b.textContent)).toEqual(["1", "25"]);
    // "of" is outside both isolates, so it follows the surrounding direction.
    expect(range!.textContent).toBe("1–50 of 1,234");
    expect(range!.querySelector("bdi")!.nextSibling!.textContent).toBe(" of ");
  });

  it("reads right-to-left in Arabic: numbers isolated, \"من\" outside both", () => {
    render(
      <I18nextProvider i18n={i18nAr}>
        <Pagination page={2} pageCount={5} total={1234} pageSize={50} dir="rtl" onPageChange={() => {}} />
      </I18nextProvider>,
    );
    const [range, pages] = liveRegions();
    const bdis = Array.from(range!.querySelectorAll("bdi"));

    expect(bdis.map((b) => b.textContent)).toEqual(["51–100", "1,234"]);
    expect(bdis.every((b) => b.getAttribute("dir") === "ltr")).toBe(true);
    expect(range!.textContent).toBe("51–100 من 1,234");
    expect(bdis.every((b) => !b.textContent!.includes("من"))).toBe(true);
    expect(range!.querySelector("bdi")!.nextSibling!.textContent).toBe(" من ");

    expect(Array.from(pages!.querySelectorAll("bdi")).map((b) => b.textContent)).toEqual(["2", "5"]);
    expect(pages!.textContent).toBe("صفحة 2 من 5");
    expect(screen.getByRole("navigation", { name: "ترقيم الصفحات" })).toBeInTheDocument();
  });

  it("disables first and previous on page 1", () => {
    renderPagination({ page: 1 });
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Last page" })).toBeEnabled();
  });

  it("disables next and last on the last page", () => {
    renderPagination({ page: 5 });
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Last page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "First page" })).toBeEnabled();
  });

  it("reports the page each button leads to", async () => {
    const props = renderPagination({ page: 3 });
    await userEvent.click(screen.getByRole("button", { name: "First page" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await userEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(vi.mocked(props.onPageChange).mock.calls.map((c) => c[0])).toEqual([1, 2, 4, 5]);
  });

  it("points the previous button the other way in a right-to-left page", () => {
    // The icon is chosen from `dir`, not rotated in CSS, so the glyph itself is what flips.
    const pathOf = (name: string) => screen.getByRole("button", { name }).querySelector("path")?.getAttribute("d");

    const { unmount } = render(
      <I18nextProvider i18n={i18n}>
        <Pagination page={2} pageCount={5} total={230} pageSize={50} dir="ltr" onPageChange={() => {}} />
      </I18nextProvider>,
    );
    const ltrPrev = pathOf("Previous page");
    const ltrNext = pathOf("Next page");
    const ltrFirst = pathOf("First page");
    unmount();

    render(
      <I18nextProvider i18n={i18n}>
        <Pagination page={2} pageCount={5} total={230} pageSize={50} dir="rtl" onPageChange={() => {}} />
      </I18nextProvider>,
    );
    expect(ltrPrev).not.toBe(ltrNext);
    expect(pathOf("Previous page")).toBe(ltrNext);
    expect(pathOf("Next page")).toBe(ltrPrev);
    expect(pathOf("First page")).not.toBe(ltrFirst);
  });

  it("offers a page size selector only when asked, and reports the choice", async () => {
    const onPageSizeChange = vi.fn();
    renderPagination({ pageSizeOptions: [25, 50, 100], onPageSizeChange });
    const select = screen.getByRole("combobox", { name: "Rows per page" });
    expect(select).toHaveValue("50");
    await userEvent.selectOptions(select, "100");
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });

  it("keeps keyboard focus on an enabled control when Next or Last reaches the end", async () => {
    function Harness() {
      const [page, setPage] = useState(4);
      return <Pagination page={page} pageCount={5} total={230} pageSize={50} dir="ltr" onPageChange={setPage} />;
    }
    render(
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toHaveFocus();
  });

  it("keeps keyboard focus on an enabled control when Previous or First reaches the start", async () => {
    function Harness() {
      const [page, setPage] = useState(2);
      return <Pagination page={page} pageCount={5} total={230} pageSize={50} dir="ltr" onPageChange={setPage} />;
    }
    render(
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "First page" }));
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveFocus();
  });
});
