import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveReceivedFilePath } from "../src/agent/core";

const outDir = "/tmp/agent-data/received";

describe("agent file transfer — resolveReceivedFilePath", () => {
  describe("rejects unsafe filenames", () => {
    const unsafe: Array<[string, string]> = [
      ["relative traversal", "../escape.txt"],
      ["nested traversal", "../../etc/passwd"],
      ["absolute path", "/etc/passwd"],
      ["forward slash", "sub/dir.txt"],
      ["backslash", "sub\\dir.txt"],
      ["empty string", ""],
      ["dot", "."],
      ["dotdot", ".."],
    ];
    for (const [label, filename] of unsafe) {
      it(`rejects ${label}`, () => {
        assert.equal(resolveReceivedFilePath(outDir, filename), null);
      });
    }
  });

  describe("allows safe filenames under the receive directory", () => {
    const safe = ["report.txt", ".gitignore", "archive.tar.gz"];
    for (const filename of safe) {
      it(`allows ${filename}`, () => {
        assert.equal(
          resolveReceivedFilePath(outDir, filename),
          `${outDir}/${filename}`,
        );
      });
    }
  });
});
