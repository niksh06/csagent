import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeRootsViolation } from "../src/engines/claudeAgentSdk.js";

const ROOTS = ["/tmp/ouro-workspace", "/Users/x/ouroboros/projects"];

describe("writeRootsViolation (I-157)", () => {
  it("allows a write inside a root (and at the root itself)", () => {
    assert.equal(writeRootsViolation("Write", { file_path: "/tmp/ouro-workspace/a/b.ts" }, ROOTS), null);
    assert.equal(writeRootsViolation("Edit", { file_path: "/Users/x/ouroboros/projects/idea/readme.md" }, ROOTS), null);
  });

  it("denies a write outside every root", () => {
    const v = writeRootsViolation("Write", { file_path: "/Users/x/Downloads/irida/src/run.ts" }, ROOTS);
    assert.ok(v && v.includes("outside the allowed write roots"));
  });

  it("prefix trickery does not escape (sibling dir sharing the prefix)", () => {
    const v = writeRootsViolation("Write", { file_path: "/tmp/ouro-workspace-evil/x" }, ROOTS);
    assert.ok(v);
  });

  it("path traversal is resolved before the check", () => {
    const v = writeRootsViolation("Edit", { file_path: "/tmp/ouro-workspace/../../etc/passwd" }, ROOTS);
    assert.ok(v);
    assert.equal(writeRootsViolation("Edit", { file_path: "/tmp/ouro-workspace/sub/../ok.ts" }, ROOTS), null);
  });

  it("resolves relative targets against the query cwd", () => {
    const cwd = "/tmp/ouro-workspace/project";
    assert.equal(writeRootsViolation("Write", { file_path: "src/new.ts" }, [cwd], cwd), null);
    assert.ok(writeRootsViolation("Write", { file_path: "../../outside.ts" }, [cwd], cwd));
    assert.ok(writeRootsViolation("Write", { file_path: "escape.ts" }, [process.cwd()], cwd));
  });

  it("fail-closed: mutation tool without a verifiable path is denied", () => {
    assert.ok(writeRootsViolation("Write", {}, ROOTS));
    assert.ok(writeRootsViolation("NotebookEdit", { notebook_path: "  " }, ROOTS));
    assert.ok(writeRootsViolation("Write", { file_path: 42 as unknown as string }, ROOTS));
  });

  it("non-mutation tools are not path-gated", () => {
    assert.equal(writeRootsViolation("Read", { file_path: "/etc/hosts" }, ROOTS), null);
    assert.equal(writeRootsViolation("Grep", { pattern: "x" }, ROOTS), null);
  });

  it("NotebookEdit is gated via notebook_path", () => {
    assert.equal(writeRootsViolation("NotebookEdit", { notebook_path: "/tmp/ouro-workspace/n.ipynb" }, ROOTS), null);
    assert.ok(writeRootsViolation("NotebookEdit", { notebook_path: "/tmp/elsewhere/n.ipynb" }, ROOTS));
  });
});
