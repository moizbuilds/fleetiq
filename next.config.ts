import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @electric-sql/pglite (demo mode's local database — lib/db/demo-db.ts,
  // only ever imported when FLEETIQ_DEMO=1) loads its own .wasm/.data
  // engine files using paths resolved relative to its OWN location inside
  // node_modules. Next's bundler (Turbopack/webpack) normally rewrites a
  // dependency's file into a bundled server chunk living somewhere else
  // entirely, which breaks that relative resolution — a real, reproduced
  // failure here (`next dev` 500s with "path argument must be of type
  // string... Received an instance of URL" the moment demo mode's first
  // query ran) until this package was excluded from bundling.
  // `serverExternalPackages` tells Next to `require()`/`import` it
  // untouched at runtime instead, so it resolves its own asset paths
  // exactly like it would in a plain Node script. This has zero effect on
  // the production (non-demo) path — nothing else in the app imports this
  // package.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
