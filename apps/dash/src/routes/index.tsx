import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { ComparisonPreview } from "@/components/comparison-preview";
import { ControlsPreview } from "@/components/controls-preview";
import { StyleOverview } from "@/components/style-overview";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export const Route = createFileRoute("/")({ component: Dashboard });

const exampleData = [
  { month: "Ene", series: 4.2 },
  { month: "Feb", series: 4.6 },
  { month: "Mar", series: 4.4 },
  { month: "Abr", series: 5.1 },
  { month: "May", series: 4.9 },
  { month: "Jun", series: 5.3 },
];

const chartConfig = {
  series: { label: "Serie de ejemplo", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function Dashboard() {
  const [showSeries, setShowSeries] = useState(true);
  let toggleLabel = "Mostrar serie";
  if (showSeries) {
    toggleLabel = "Ocultar serie";
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6 sm:gap-10 sm:px-6 sm:py-12">
      <header className="flex max-w-prose flex-col gap-4 px-2 py-6 sm:py-8">
        <h1 className="font-heading text-5xl font-bold tracking-tight text-balance sm:text-7xl">
          CrediVá
        </h1>
        <p className="max-w-prose text-lg leading-relaxed text-foreground sm:text-xl">
          Explora tasas de interés de créditos en Colombia. Aún no hay datos de la fuente
          conectados.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Datos de ejemplo ficticios</CardTitle>
          <CardDescription>Valores de prueba para comprobar la gráfica.</CardDescription>
          <CardAction>
            <Button variant="outline" onClick={() => setShowSeries((shown) => !shown)}>
              {toggleLabel}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <ChartContainer config={chartConfig} className="min-h-64 w-full sm:min-h-80">
            <LineChart accessibilityLayer data={exampleData}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="month" />
              <YAxis domain={["auto", "auto"]} />
              <ChartTooltip content={<ChartTooltipContent />} />
              {showSeries && <Line dataKey="series" stroke="var(--color-series)" strokeWidth={2} />}
            </LineChart>
          </ChartContainer>
        </CardContent>
        <CardFooter>
          <p className="text-muted-foreground">No son observaciones reales de tasas de crédito.</p>
        </CardFooter>
      </Card>
      <section aria-labelledby="examples-heading" className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2 id="examples-heading" className="font-heading text-3xl font-semibold">
            Explora los componentes
          </h2>
          <p className="text-muted-foreground">
            Bloques de ejemplo para revisar el estilo antes de conectar los datos.
          </p>
        </header>
        <StyleOverview />
        <div className="grid gap-6 lg:grid-cols-2">
          <ComparisonPreview />
          <ControlsPreview />
        </div>
      </section>
      <Link
        className="w-fit text-foreground underline decoration-primary underline-offset-4"
        to="/about"
      >
        Acerca de CrediVá
      </Link>
    </main>
  );
}
