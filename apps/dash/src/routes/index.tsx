import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
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
  { month: "Jan", series: 4.2 },
  { month: "Feb", series: 4.6 },
  { month: "Mar", series: 4.4 },
  { month: "Apr", series: 5.1 },
  { month: "May", series: 4.9 },
  { month: "Jun", series: 5.3 },
];

const chartConfig = {
  series: { label: "Example series", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function Dashboard() {
  const [showSeries, setShowSeries] = useState(true);
  let toggleLabel = "Show series";
  if (showSeries) {
    toggleLabel = "Hide series";
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12 sm:py-16">
      <header className="flex max-w-prose flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Lending interest rates
        </h1>
        <p className="text-lg leading-relaxed text-muted-foreground">
          A space for exploring lending-rate data. No source data is connected yet.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Synthetic example data</CardTitle>
          <CardDescription>Placeholder values for checking the chart integration.</CardDescription>
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
          <p className="text-muted-foreground">Not actual lending-rate observations.</p>
        </CardFooter>
      </Card>
      <Link className="w-fit text-primary underline underline-offset-4" to="/about">
        About this scaffold
      </Link>
    </main>
  );
}
