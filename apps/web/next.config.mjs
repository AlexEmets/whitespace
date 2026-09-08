import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @whitespace/shared ships plain ESM .mjs source (no build step); make sure Next's
  // compiler processes it like first-party code instead of treating it as an opaque
  // pre-built node_modules dependency.
  transpilePackages: ['@whitespace/shared'],
  // This worktree's own pnpm-lock.yaml sits two directories above apps/web, but the
  // *parent* checkout (this repo is itself a git worktree) has another lockfile further
  // up the same path — without this, Next's root inference picks the wrong one and
  // traces files outside this worktree. Pin it explicitly to this worktree's root.
  outputFileTracingRoot: path.join(dirname, '../..'),
};

export default nextConfig;
