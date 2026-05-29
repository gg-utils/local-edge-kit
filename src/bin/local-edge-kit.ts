#!/usr/bin/env tsx
/**
 * @fileoverview Stub `local-edge-kit` package binary that refuses to run without a repository-owned
 * adapter that wires `local-edge.config.ts` into `LocalEdgeKit_runCli`.
 *
 * This file owns the published `bin` entrypoint used when the package executable runs without a
 * repo-local wrapper; it prints a stderr guidance message and exits with code 2 so no implicit
 * config path resolution runs.
 * Flow: direct execution → stderr guidance → `process.exit(2)`.
 *
 * @testing CLI: npm run test --prefix packages/local-edge-kit
 *
 * @see packages/local-edge-kit/src/cli.ts - Defines LocalEdgeKit_runCli, which repository-owned scripts must invoke with an explicit kit adapter instead of relying on this stub binary.
 * @see local-edge.config.ts - Root-repo adapter wiring kit commands to the platform local-edge contract; normal workflows call LocalEdgeKit_runCli from a similar script instead of this bin.
 * @see docs/TYPESCRIPT_STANDARDS_DOCUMENTATION_FILE_OVERVIEWS.md - File-overview standard governing this header's verification tags and tag order for repo CI and agents.
 * @documentation reviewed=2026-05-22 standard=FILE_OVERVIEW_STANDARDS_TYPESCRIPT@3
 */

console.error(
  "local-edge-kit requires a repository adapter that passes local-edge.config.ts to LocalEdgeKit_runCli.",
);
process.exit(2);
