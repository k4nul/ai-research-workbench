import { describe, expect, it } from "vitest";

import {
  CLEANUP_ORPHANS_HELP,
  UNTRACKED_DELETION_WARNING,
  cleanupOrphanCliNotice
} from "@/scripts/cleanup-orphans";

describe("orphan cleanup CLI safety notice", () => {
  it("documents the untracked-deletion quiescence requirement in help", () => {
    expect(cleanupOrphanCliNotice(["--help"])).toEqual({
      kind: "help",
      message: CLEANUP_ORPHANS_HELP
    });
    expect(CLEANUP_ORPHANS_HELP).toContain("stop all artifact writers and workers");
    expect(CLEANUP_ORPHANS_HELP).toContain("point-in-time reconciliation");
  });

  it("emits a runtime warning whenever untracked deletion is enabled", () => {
    expect(cleanupOrphanCliNotice(["--delete-untracked"])).toEqual({
      kind: "warning",
      message: UNTRACKED_DELETION_WARNING
    });
    expect(UNTRACKED_DELETION_WARNING).toContain("must be quiesced before use");
  });
});
