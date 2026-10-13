import { describe, expect, it } from "vitest";
import { parseRefUpdates, isProtectedRef, classifyRefUpdate, classifyPush, ZERO_SHA } from "./push-guard-core.mjs";

describe("parseRefUpdates — parse pre-push hook stdin", () => {
  it("parses a single ref update line", () => {
    const stdin = "refs/heads/feature abc123 refs/heads/main def456\n";
    expect(parseRefUpdates(stdin)).toEqual([
      { localRef: "refs/heads/feature", localSha: "abc123", remoteRef: "refs/heads/main", remoteSha: "def456" },
    ]);
  });

  it("parses multiple ref update lines", () => {
    const stdin = "refs/heads/a a1 refs/heads/a a2\nrefs/heads/b b1 refs/heads/b b2\n";
    expect(parseRefUpdates(stdin)).toHaveLength(2);
  });

  it("ignores blank lines", () => {
    const stdin = "\nrefs/heads/a a1 refs/heads/a a2\n\n";
    expect(parseRefUpdates(stdin)).toHaveLength(1);
  });

  it("returns an empty array for empty stdin", () => {
    expect(parseRefUpdates("")).toEqual([]);
    expect(parseRefUpdates(undefined)).toEqual([]);
  });
});

describe("isProtectedRef — main/master by default", () => {
  it("matches refs/heads/main", () => {
    expect(isProtectedRef("refs/heads/main")).toBe(true);
  });

  it("matches refs/heads/master", () => {
    expect(isProtectedRef("refs/heads/master")).toBe(true);
  });

  it("does not match a feature branch", () => {
    expect(isProtectedRef("refs/heads/feature-x")).toBe(false);
  });

  it("honors a custom protected branch list", () => {
    expect(isProtectedRef("refs/heads/release", ["release"])).toBe(true);
    expect(isProtectedRef("refs/heads/main", ["release"])).toBe(false);
  });
});

describe("classifyRefUpdate — Tier 3 only for non-fast-forward pushes to protected branches", () => {
  const isAncestor = (ancestor: string, descendant: string) => ancestor === descendant;

  it("is Tier 1 for a fast-forward push to main", () => {
    const update = { localRef: "refs/heads/main", localSha: "x", remoteRef: "refs/heads/main", remoteSha: "x" };
    expect(classifyRefUpdate(update, { isAncestor })).toBe(1);
  });

  it("is Tier 3 for a non-fast-forward (rewriting) push to main", () => {
    const update = { localRef: "refs/heads/main", localSha: "new", remoteRef: "refs/heads/main", remoteSha: "old" };
    const notAncestor = () => false;
    expect(classifyRefUpdate(update, { isAncestor: notAncestor })).toBe(3);
  });

  it("is Tier 1 for a non-fast-forward push to a non-protected branch", () => {
    const update = { localRef: "refs/heads/feature", localSha: "new", remoteRef: "refs/heads/feature", remoteSha: "old" };
    const notAncestor = () => false;
    expect(classifyRefUpdate(update, { isAncestor: notAncestor })).toBe(1);
  });

  it("is Tier 1 for a brand-new protected branch (remoteSha is all zeros)", () => {
    const update = { localRef: "refs/heads/main", localSha: "new", remoteRef: "refs/heads/main", remoteSha: ZERO_SHA };
    const notAncestor = () => false;
    expect(classifyRefUpdate(update, { isAncestor: notAncestor })).toBe(1);
  });

  it("is Tier 1 for a branch deletion (localSha is all zeros)", () => {
    const update = { localRef: "(delete)", localSha: ZERO_SHA, remoteRef: "refs/heads/main", remoteSha: "old" };
    const notAncestor = () => false;
    expect(classifyRefUpdate(update, { isAncestor: notAncestor })).toBe(1);
  });
});

describe("classifyPush — classify every ref update from raw stdin", () => {
  it("flags a force-push to main among multiple updates", () => {
    const stdin = [
      "refs/heads/feature f1 refs/heads/feature f0",
      "refs/heads/main m1 refs/heads/main m0",
    ].join("\n");
    const isAncestor = (a: string, d: string) => a === "f0" && d === "f1"; // feature is fast-forward, main is not
    const results = classifyPush(stdin, { isAncestor });
    expect(results.find((r) => r.update.remoteRef === "refs/heads/feature")!.tier).toBe(1);
    expect(results.find((r) => r.update.remoteRef === "refs/heads/main")!.tier).toBe(3);
  });
});
