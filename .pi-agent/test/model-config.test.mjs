import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("every profile keeps Opus 5.5 in the 200K prompt tier and marks thinking as required", async () => {
  for (const profile of ["e14", "coop", "gfe"]) {
    const config = JSON.parse(await readFile(new URL(`../models.${profile}.json`, import.meta.url), "utf8"));
    const model = config.providers["github-copilot"].models.find(({ id }) => id === "claude-opus-5.5");

    assert.ok(model, `${profile} profile is missing Claude Opus 5.5`);
    assert.equal(model.contextWindow, 200_000, `${profile} profile crosses Copilot's default prompt tier`);
    assert.equal(model.thinkingLevelMap.off, null, `${profile} profile must reject disabled thinking`);
  }
});
