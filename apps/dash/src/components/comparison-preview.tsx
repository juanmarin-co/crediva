import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

// Adapted from shadcn/ui's BarChartCard preview with fictitious series only.
const exampleData = [
  { month: "Ene", first: 43, second: 32 },
  { month: "Feb", first: 52, second: 41 },
  { month: "Mar", first: 39, second: 48 },
  { month: "Abr", first: 60, second: 45 },
  { month: "May", first: 55, second: 50 },
  { month: "Jun", first: 63, second: 54 },
];

const chartConfig = {
  first: { label: "Serie A", color: "var(--chart-2)" },
  second: { label: "Serie B", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function ComparisonPreview() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Comparación de ejemplo</CardTitle>
        <CardDescription>
          Dos series ficticias para probar la presentación de datos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="min-h-52 w-full">
          <BarChart accessibilityLayer data={exampleData}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="first" fill="var(--color-first)" radius={4} />
            <Bar dataKey="second" fill="var(--color-second)" radius={4} />
          </BarChart>
        </ChartContainer>
      </CardContent>
      <CardFooter>
        <p className="text-muted-foreground">No son tasas ni datos de la fuente.</p>
      </CardFooter>
    </Card>
  );
}
