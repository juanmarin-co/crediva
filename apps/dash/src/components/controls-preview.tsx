import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

// A small CrediVá composition based on shadcn/ui's UIElements preview block.
export function ControlsPreview() {
  const [sampled, setSampled] = useState(false);
  let actionLabel = "Probar acción";
  if (sampled) {
    actionLabel = "Reiniciar muestra";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Controles de ejemplo</CardTitle>
        <CardDescription>Una muestra de componentes para explorar el estilo.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Destacado</Badge>
          <Badge variant="secondary">Secundario</Badge>
          <Badge variant="outline">Contorno</Badge>
        </div>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="preview-product">Producto de crédito</FieldLabel>
            <Input id="preview-product" placeholder="Buscar un producto…" />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Tipo de crédito</FieldLegend>
            <ToggleGroup variant="outline" defaultValue={["consumo"]}>
              <ToggleGroupItem value="consumo">Consumo</ToggleGroupItem>
              <ToggleGroupItem value="vivienda">Vivienda</ToggleGroupItem>
            </ToggleGroup>
          </FieldSet>
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setSampled((active) => !active)}>
            {actionLabel}
          </Button>
          <Button type="button" variant="outline" disabled>
            Descargar
          </Button>
          {sampled && <Badge variant="secondary">Interacción local</Badge>}
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-muted-foreground">Vista previa: estos controles no consultan datos.</p>
      </CardFooter>
    </Card>
  );
}
