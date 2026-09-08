// Ponder requires a default-exported Hono app at src/api/index.ts to boot
// `ponder start`/`ponder dev` at all (see
// https://ponder.sh/docs/api-reference/ponder/api-endpoints). This indexer
// does not serve reads itself — that is services/api's job, which talks to
// the same Postgres database directly (see the architecture diagram in
// docs/superpowers/specs/2026-09-08-whitechain-perp-dex-design.md §4). This
// file is intentionally minimal: Ponder's own built-in `/health`, `/ready`
// and `/status` endpoints (see docs/production/self-hosting.mdx and
// docs/advanced/observability.mdx) come for free regardless of what's
// registered here, so this indexer process is still independently
// health-checkable without services/api running.
import { Hono } from 'hono';

const app = new Hono();

export default app;
