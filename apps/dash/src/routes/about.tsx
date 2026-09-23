import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({ component: About });

function About() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12 sm:py-16">
      <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
        Acerca de CrediVá
      </h1>
      <p className="max-w-prose text-lg leading-relaxed text-muted-foreground">
        CrediVá explorará datos históricos agregados de tasas de crédito en Colombia. Esta versión
        aún no tiene datos de la fuente conectados.
      </p>
      <Link
        className="w-fit text-foreground underline decoration-primary underline-offset-4"
        to="/"
      >
        Volver a CrediVá
      </Link>
    </main>
  );
}
