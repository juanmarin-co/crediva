# CrediVá dashboard

The dashboard is CrediVá's interface for exploring historical, aggregated lending-interest-rate data in Colombia. It does not display current credit offers. The current chart uses fictitious example values; no source data is connected.

The dashboard uses TanStack Start, Tailwind CSS v4, shadcn/ui (Base UI, Nova) and shadcn Chart (Recharts). The home page includes adaptations of shadcn/ui's [StyleOverview](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/blocks/preview/cards/style-overview.tsx), [BarChartCard](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/blocks/preview/cards/bar-chart-card.tsx), and [UIElements](https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/blocks/preview/cards/ui-elements.tsx) previews. These examples depend on site-specific state upstream, so the page composes the installed shadcn/ui components locally rather than copying the blocks unchanged.

From the repository root:

```sh
pnpm install
pnpm --filter @crediva/dash dev
pnpm --filter @crediva/dash build
```

The build prerenders every static route to `apps/dash/dist/client` and also produces a Cloudflare Worker bundle in `apps/dash/dist/server`. Dynamic parameter routes must be given explicit paths or reachable links to be prerendered; check the build log whenever adding routes. For a local Cloudflare Workers deployment, authenticate with Wrangler, then run `pnpm --filter @crediva/dash deploy`. Alternatively, set the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub repository secrets, then run the **Deploy dashboard** workflow manually from GitHub Actions. Use an API token scoped to the deployment account with Edit Cloudflare Workers permission. No deploy is required for local development.
