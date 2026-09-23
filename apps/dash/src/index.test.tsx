import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/about">{children}</a>,
}));

import { StyleOverview } from "./components/style-overview";
import { Dashboard } from "./routes/index";

describe("CrediVá", () => {
  it("labels its example chart as fictitious data", () => {
    const html = renderToStaticMarkup(<Dashboard />);

    expect(html).toContain("CrediVá");
    expect(html).toContain("Datos de ejemplo ficticios");
    expect(html).toContain("Aún no hay datos de la fuente conectados");
    expect(html).toContain("Vista del estilo");
    expect(html).toContain("Comparación de ejemplo");
    expect(html).toContain("Controles de ejemplo");
  });

  it("shows a shadcn block adapted to the CrediVá theme", () => {
    const html = renderToStaticMarkup(<StyleOverview />);

    expect(html).toContain("Fraunces");
    expect(html).toContain("Onest");
    expect(html).toContain("--chart-1");
    expect(html).toContain("Adaptado del bloque StyleOverview de shadcn/ui");
  });
});
