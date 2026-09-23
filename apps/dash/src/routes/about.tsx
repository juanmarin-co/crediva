import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({ component: About });

function About() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12 sm:py-16">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">About</h1>
      <p className="max-w-prose text-lg leading-relaxed text-muted-foreground">
        This is a scaffold. No source data is connected yet.
      </p>
      <Link className="w-fit text-primary underline underline-offset-4" to="/">
        Back to dashboard
      </Link>
    </main>
  );
}
