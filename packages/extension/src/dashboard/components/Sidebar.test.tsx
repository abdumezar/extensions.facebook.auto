import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import pkg from "../../../package.json";
import { Sidebar } from "./Sidebar.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: { version?: string }) => `${key}|${options?.version ?? ""}` }),
}));

afterEach(() => vi.unstubAllGlobals());

describe("Sidebar version", () => {
  it("shows the version the installed manifest declares, in both the drawer and the rail", () => {
    vi.stubGlobal("chrome", { runtime: { getManifest: () => ({ version: "7.8.9" }) } });
    render(<Sidebar />);
    expect(screen.getByText("app.version|7.8.9")).toBeInTheDocument();
    expect(screen.getByText("v7.8.9")).toBeInTheDocument();
  });

  it("falls back to the package version when there is no extension runtime", () => {
    render(<Sidebar />);
    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
    expect(screen.queryByText(/0\.1\.0/)).not.toBeInTheDocument();
  });
});
