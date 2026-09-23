# Dashboard scaffold

TanStack Start dashboard scaffold with Tailwind CSS v4, shadcn/ui (Base UI, Nova) and shadcn Chart (Recharts). The chart uses synthetic example values; no source data is connected.

From the repository root:

```sh
pnpm install
pnpm --filter @lending-interest-rates/dash dev
pnpm --filter @lending-interest-rates/dash build
```

The build prerenders every static route to `apps/dash/dist/client` and also produces a Cloudflare Worker bundle in `apps/dash/dist/server`. Dynamic parameter routes must be given explicit paths or reachable links to be prerendered; check the build log whenever adding routes. For a manual Cloudflare Workers deployment, authenticate with Wrangler, then run `pnpm --filter @lending-interest-rates/dash deploy`. No deploy is required for local development.
