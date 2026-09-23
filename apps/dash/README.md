# CrediVá

CrediVá (`crediva` in ASCII identifiers) is a dashboard for exploring historical, aggregated lending-interest-rate data in Colombia. It does not display current credit offers. The current chart uses fictitious example values; no source data is connected.

The app uses TanStack Start, Tailwind CSS v4, shadcn/ui (Base UI, Nova) and shadcn Chart (Recharts).

From the repository root:

```sh
pnpm install
pnpm --filter @crediva/dash dev
pnpm --filter @crediva/dash build
```

The build prerenders every static route to `apps/dash/dist/client` and also produces a Cloudflare Worker bundle in `apps/dash/dist/server`. Dynamic parameter routes must be given explicit paths or reachable links to be prerendered; check the build log whenever adding routes. For a manual Cloudflare Workers deployment, authenticate with Wrangler, then run `pnpm --filter @crediva/dash deploy`. No deploy is required for local development.
