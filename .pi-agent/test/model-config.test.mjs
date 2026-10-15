import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Copilot lists Opus 5.5 at max_prompt_tokens 1,000,000, and its long_context
// tier costs the same as the 200K default (440/550/22/2200 AIU per M), so the
// profiles use the full window; a 262K request from pi was accepted.
test("every profile gives Opus 5.5 Copilot's 1M window and marks thinking as required", async () => {
  for (const profile of ["e14", "coop", "gfe"]) {
    const config = JSON.parse(await readFile(new URL(`../models.${profile}.json`, import.meta.url), "utf8"));
    const model = config.providers["github-copilot"].models.find(({ id }) => id === "claude-opus-5.5");

    assert.ok(model, `${profile} profile is missing Claude Opus 5.5`);
    assert.equal(model.contextWindow, 1_000_000, `${profile} profile should use Copilot's 1M Opus 5.5 window`);
    assert.equal(model.thinkingLevelMap.off, null, `${profile} profile must reject disabled thinking`);
  }
});
