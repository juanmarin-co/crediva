import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/about">{children}</a>,
}));

import { Dashboard } from "./routes/index";

describe("dashboard scaffold", () => {
  it("labels its example chart as synthetic data", () => {
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain("Synthetic example data");
    expect(html).toContain("No source data is connected yet");
  });
});
