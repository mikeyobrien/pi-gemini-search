import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeminiPrompt,
  coerceStructuredResult,
  createProgressCounters,
  formatProgressStatus,
  normalizeAsOfPeriod,
  normalizeSources,
  parseGeminiStreamEvents,
  parseJsonObject,
  updateProgressCountersFromEvent
} from "../lib/gemini-runner.mjs";

test("buildGeminiPrompt includes as_of framing and one-pass behavior", () => {
  const prompt = buildGeminiPrompt({
    question: "What is the latest npm version",
    asOfPeriod: "mid",
    asOfYear: 2026
  });

  assert.match(prompt, /latest npm version/i);
  assert.match(prompt, /as of mid 2026/i);
  assert.match(prompt, /Do not execute commands or modify files/i);
  assert.match(prompt, /Do not ask clarifying questions/i);
  assert.match(prompt, /source URLs/i);
});

test("parseJsonObject parses plain and fenced json", () => {
  assert.deepEqual(parseJsonObject('{"answer":"ok"}'), { answer: "ok" });
  assert.deepEqual(parseJsonObject("```json\n{\n  \"answer\": \"ok\"\n}\n```"), { answer: "ok" });
  assert.equal(parseJsonObject("not json"), null);
});

test("normalizeSources deduplicates and filters invalid URLs", () => {
  const normalized = normalizeSources([
    "https://example.com/a",
    "https://example.com/a",
    "http://example.org/b",
    "ftp://example.net/c",
    "nope"
  ]);

  assert.deepEqual(normalized, ["https://example.com/a", "http://example.org/b"]);
});

test("parseGeminiStreamEvents extracts tool events and assistant text", () => {
  const jsonl = [
    JSON.stringify({ type: "init", session_id: "s1", model: "auto-gemini-3" }),
    JSON.stringify({ type: "message", role: "assistant", content: "Hello ", delta: true }),
    JSON.stringify({ type: "tool_use", tool_name: "google_web_search", tool_id: "t1", parameters: { query: "npm" } }),
    JSON.stringify({ type: "tool_result", tool_id: "t1", status: "success", output: "ok" }),
    JSON.stringify({ type: "message", role: "assistant", content: "world", delta: true }),
    JSON.stringify({ type: "result", status: "success", stats: { tool_calls: 1 } })
  ].join("\n");

  const parsed = parseGeminiStreamEvents(jsonl);

  assert.equal(parsed.toolUses.length, 1);
  assert.equal(parsed.toolUses[0].tool_name, "google_web_search");
  assert.equal(parsed.toolResults.length, 1);
  assert.equal(parsed.finalResult?.status, "success");
  assert.equal(parsed.assistantText, "Hello world");
});

test("progress counters track search activity", () => {
  const counters = createProgressCounters();

  const searchEvent = {
    type: "tool_use",
    tool_name: "google_web_search",
    parameters: { query: "latest npm version" }
  };
  const nonWebToolEvent = {
    type: "tool_use",
    tool_name: "run_shell_command",
    parameters: { command: "pwd" }
  };

  updateProgressCountersFromEvent(searchEvent, counters);
  updateProgressCountersFromEvent(nonWebToolEvent, counters);

  assert.equal(counters.searches, 1);
  assert.match(counters.lastAction, /search:/i);
});

test("formatProgressStatus includes search counters", () => {
  const counters = createProgressCounters();
  counters.searches = 2;
  counters.lastAction = "search: npm latest";

  const text = formatProgressStatus(counters, Date.now() - 1800);

  assert.match(text, /Running Gemini web search/);
  assert.match(text, /searches: 2/);
  assert.doesNotMatch(text, /other tools:/);
  assert.match(text, /last action: search: npm latest/);
});

test("coerceStructuredResult accepts minimal object and optional confidence", () => {
  const minimal = coerceStructuredResult({
    answer: "npm 11.10.1",
    sources: ["https://www.npmjs.com/package/npm", "https://www.npmjs.com/package/npm"],
    notes: "official package page"
  });

  const withConfidence = coerceStructuredResult({
    answer: "npm 11.10.1",
    as_of: "2026-02-21",
    confidence: "high",
    sources: ["https://www.npmjs.com/package/npm"]
  });

  assert.equal(minimal?.answer, "npm 11.10.1");
  assert.equal(minimal?.as_of, "");
  assert.equal(minimal?.confidence, undefined);
  assert.deepEqual(minimal?.sources, ["https://www.npmjs.com/package/npm"]);

  assert.equal(withConfidence?.confidence, 0.85);
  assert.equal(withConfidence?.as_of, "2026-02-21");
});

test("normalizeAsOfPeriod falls back to early", () => {
  assert.equal(normalizeAsOfPeriod("late"), "late");
  assert.equal(normalizeAsOfPeriod("MID"), "mid");
  assert.equal(normalizeAsOfPeriod("???"), "early");
});
