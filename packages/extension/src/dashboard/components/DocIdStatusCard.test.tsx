import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { DEFAULT_FB_RECIPE, recipeFriendlyNames, type DocIdRow } from "@nashir/shared";
import { formatTimestamp } from "../lib/format.js";
import { en } from "../i18n/en.js";
import { ar } from "../i18n/ar.js";
import { DOC_ID_HINTS, DocIdStatusCard, hintFor } from "./DocIdStatusCard.js";

/**
 * Translations are absent under test, so react-i18next echoes the key — these
 * assertions are about WHICH string was chosen, not about its wording.
 */

const SEEN = Date.UTC(2026, 10, 3, 9, 30);

/** A real instance with no resources: keys still echo, but `language` is known. */
function withLanguage(lng: string, ui: React.ReactElement) {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({ lng, resources: {}, interpolation: { escapeValue: false } });
  return <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>;
}

function row(over: Partial<DocIdRow> & Pick<DocIdRow, "name">): DocIdRow {
  return { active: "1111111111111111", source: "bundled", ...over };
}

describe("DocIdStatusCard", () => {
  it("shows learned ids with their date and a hint for operations never seen", () => {
    render(
      withLanguage(
        "en",
        <DocIdStatusCard
          rows={[
            row({
              name: "CometUFIReactionsDialogQuery",
              active: "28949165141359436",
              source: "learned",
              seenAt: SEEN,
            }),
            row({ name: "CommentListComponentsRootQuery", active: "2222222222222222" }),
          ]}
        />,
      ),
    );

    const learned = screen.getByRole("row", { name: /CometUFIReactionsDialogQuery/ });
    expect(within(learned).getByText("28949165141359436")).toBeInTheDocument();
    expect(within(learned).getByText("docIds.source_learned")).toBeInTheDocument();
    // A learned id carries its date and needs no hint.
    expect(within(learned).getByText(formatTimestamp(SEEN, "en"))).toBeInTheDocument();
    expect(within(learned).queryByText("—")).not.toBeInTheDocument();
    expect(within(learned).queryByText(/docIds\.hint_/)).not.toBeInTheDocument();

    const bundled = screen.getByRole("row", { name: /CommentListComponentsRootQuery/ });
    expect(within(bundled).getByText("2222222222222222")).toBeInTheDocument();
    expect(within(bundled).getByText("docIds.source_bundled")).toBeInTheDocument();
    expect(within(bundled).getByText("—")).toBeInTheDocument();
    // The dash is decoration; assistive tech reads the words.
    expect(within(bundled).getByText("docIds.notLearned")).toBeInTheDocument();
    expect(within(bundled).getByText("docIds.hint_comments")).toBeInTheDocument();
  });

  it("is a table with named columns and a title", () => {
    render(<DocIdStatusCard rows={[row({ name: "ComposerStoryCreateMutation" })]} />);

    expect(screen.getByRole("table", { name: "docIds.title" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(screen.getByText("docIds.title")).toBeInTheDocument();
  });

  it("keeps names and ids left-to-right so an Arabic page cannot reorder them", () => {
    render(
      <DocIdStatusCard
        rows={[row({ name: "GroupsCometJoinsRootQuery", active: "3333333333333333" })]}
      />,
    );

    expect(screen.getByText("3333333333333333").closest("[dir]")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("GroupsCometJoinsRootQuery").closest("[dir]")).toHaveAttribute("dir", "ltr");
  });

  it("falls back to the home-feed hint for an operation it has no screen for", () => {
    render(<DocIdStatusCard rows={[row({ name: "SomethingFacebookAddedLater" })]} />);

    expect(screen.getByText("docIds.hint_feed")).toBeInTheDocument();
  });

  it("does not trust a name that merely resembles an object property", () => {
    expect(hintFor("constructor")).toBe("feed");
    expect(hintFor("__proto__")).toBe("feed");
  });
});

describe("DOC_ID_HINTS", () => {
  it("covers exactly the operations the bundled recipe carries", () => {
    expect(Object.keys(DOC_ID_HINTS).sort()).toEqual(recipeFriendlyNames(DEFAULT_FB_RECIPE).sort());
  });

  it("points each operation at the screen that uses it", () => {
    expect(DOC_ID_HINTS).toMatchObject({
      ComposerStoryCreateMutation: "composer",
      GroupsCometJoinsRootQuery: "groups",
      GroupsCometAllJoinedGroupsSectionPaginationQuery: "groups",
      GroupsCometLeaveDialogQuery: "leave",
      useGroupLeaveMutation: "leave",
      CometUFIReactionsDialogQuery: "reactions",
      CometUFIReactionsDialogTabContentRefetchQuery: "reactions",
      CommentListComponentsRootQuery: "comments",
      CommentsListComponentsPaginationQuery: "comments",
    });
  });

  it("has an English and an Arabic sentence for every hint", () => {
    for (const hint of new Set(Object.values(DOC_ID_HINTS))) {
      expect(en.docIds[`hint_${hint}` as keyof typeof en.docIds]).toBeTruthy();
      expect(ar.docIds[`hint_${hint}` as keyof typeof ar.docIds]).toBeTruthy();
    }
    expect(en.docIds.hint_feed).toBeTruthy();
    expect(ar.docIds.hint_feed).toBeTruthy();
  });

  it("is named 'Facebook operations', the name the contributor docs point to", () => {
    expect(en.docIds.title).toBe("Facebook operations");
  });
});
