import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArchitecture } from "../lib/architecture/check";

test("架构门禁：当前代码库无任何服务层/契约层违规", () => {
  const violations = checkArchitecture();
  if (violations.length) {
    console.error(violations.join("\n"));
  }
  assert.equal(violations.length, 0, `存在 ${violations.length} 处架构违规`);
});
