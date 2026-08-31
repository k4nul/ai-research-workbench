import { describe, expect, it } from "vitest";

import { compareMigrationInventories } from "@/lib/operations/migration-inventory";

describe("migration inventory", () => {
  const local = [
    { name: "001_initial.sql", checksum: "one" },
    { name: "002_feature.sql", checksum: "two" }
  ];

  it("requires the exact local filename and checksum set", () => {
    expect(
      compareMigrationInventories(local, [
        { name: "001_initial.sql", checksum: "one" },
        { name: "002_feature.sql", checksum: "two" }
      ])
    ).toEqual({
      matches: true,
      missing: [],
      unexpected: [],
      checksumMismatches: []
    });
  });

  it("rejects missing, unexpected, changed, and legacy null checksums", () => {
    expect(
      compareMigrationInventories(local, [
        { name: "001_initial.sql", checksum: null },
        { name: "999_future.sql", checksum: "future" }
      ])
    ).toEqual({
      matches: false,
      missing: ["002_feature.sql"],
      unexpected: ["999_future.sql"],
      checksumMismatches: ["001_initial.sql"]
    });
  });
});
