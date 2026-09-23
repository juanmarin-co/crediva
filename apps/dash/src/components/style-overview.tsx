import type { CSSProperties } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Adapted from shadcn/ui's StyleOverview preview; the upstream block depends on its site-specific state.
const swatches = [
  { label: "Fondo", token: "--background" },
  { label: "Texto", token: "--foreground" },
  { label: "Acción", token: "--primary" },
  { label: "Superficie", token: "--secondary" },
  { label: "Selección", token: "--accent" },
  { label: "Líneas", token: "--border" },
  { label: "Serie 1", token: "--chart-1" },
  { label: "Serie 2", token: "--chart-2" },
  { label: "Serie 3", token: "--chart-3" },
  { label: "Serie 4", token: "--chart-4" },
  { label: "Serie 5", token: "--chart-5" },
] as const;

export function StyleOverview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Vista del estilo</CardTitle>
        <CardDescription>Tipografía y colores de CrediVá.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <p className="font-heading text-3xl font-semibold">Descubre patrones</p>
          <p className="max-w-prose leading-relaxed text-muted-foreground">
            Fraunces para titulares; Onest para leer, explorar y comparar datos.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
          {swatches.map(({ label, token }) => (
            <div key={token} className="flex min-w-0 flex-col gap-2">
              <div
                aria-hidden="true"
                className="aspect-square rounded-lg border border-border"
                style={{ backgroundColor: `var(${token})` } as CSSProperties}
              />
              <span className="text-sm font-medium">{label}</span>
              <code className="truncate text-xs text-muted-foreground">{token}</code>
            </div>
          ))}
        </div>
      </CardContent>
      <CardFooter>
        <a
          href="https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/blocks/preview/cards/style-overview.tsx"
          className="text-foreground underline decoration-primary underline-offset-4"
          target="_blank"
          rel="noopener noreferrer"
        >
          Adaptado del bloque StyleOverview de shadcn/ui
        </a>
      </CardFooter>
    </Card>
  );
}
