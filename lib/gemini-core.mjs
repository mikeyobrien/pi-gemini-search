export const DEFAULT_TIMEOUT_SEC = 180;
export const MAX_TIMEOUT_SEC = 3600;
export const DEFAULT_MAX_SOURCES = 8;
export const PROGRESS_HEARTBEAT_MS = 5000;
export const PROGRESS_MIN_INTERVAL_MS = 350;

export function normalizeAsOfPeriod(value) {
  const period = String(value || "early").toLowerCase();
  if (period === "early" || period === "mid" || period === "late") return period;
  return "early";
}

export function buildGeminiPrompt({ question, asOfPeriod = "early", asOfYear = new Date().getUTCFullYear() }) {
  const period = normalizeAsOfPeriod(asOfPeriod);
  return [
    `${question}.`,
    "Use google_web_search for current information.",
    `Search for the latest available information as of ${period} ${asOfYear}.`,
    "Do not execute commands or modify files.",
    "Respond in one pass. Do not ask clarifying questions.",
    "Return an answer with source URLs (if available)."
  ].join(" ");
}

export function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
}

function stripTrailingUrlPunctuation(url) {
  return url.replace(/[),.;!?]+$/g, "");
}

export function extractUrls(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const matches = text.match(/https?:\/\/[^\s\]>)"']+/g) || [];
  return matches.map(stripTrailingUrlPunctuation);
}

export function normalizeSources(rawSources, maxSources = DEFAULT_MAX_SOURCES) {
  const values = Array.isArray(rawSources) ? rawSources : [];
  const seen = new Set();
  const out = [];

  for (const source of values) {
    if (typeof source !== "string") continue;
    const value = source.trim();
    if (!value) continue;

    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= maxSources) break;
    } catch {
      continue;
    }
  }

  return out;
}

function shortValue(value, maxLen = 96) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen - 1)}…`;
}

export function createProgressCounters() {
  return {
    searches: 0,
    lastAction: "starting"
  };
}

export function updateProgressCountersFromEvent(event, counters) {
  if (!event || typeof event !== "object") {
    return { changed: false, lastAction: counters.lastAction };
  }

  if (event.type === "tool_use") {
    const toolName = event.tool_name || "unknown";
    if (toolName === "google_web_search") {
      counters.searches += 1;
      const query = shortValue(event.parameters?.query || "");
      counters.lastAction = query ? `search: ${query}` : "search";
      return { changed: true, lastAction: counters.lastAction };
    }

    return { changed: false, lastAction: counters.lastAction };
  }

  if (event.type === "tool_result") {
    const status = event.status || "unknown";
    counters.lastAction = `tool result: ${status}`;
    return { changed: true, lastAction: counters.lastAction };
  }

  if (event.type === "message" && event.role === "assistant") {
    counters.lastAction = "drafting answer";
    return { changed: true, lastAction: counters.lastAction };
  }

  if (event.type === "result") {
    counters.lastAction = "finalized";
    return { changed: true, lastAction: counters.lastAction };
  }

  if (event.type === "error") {
    counters.lastAction = "error event";
    return { changed: true, lastAction: counters.lastAction };
  }

  return { changed: false, lastAction: counters.lastAction };
}

export function formatProgressStatus(counters, startedAtMs = Date.now()) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  return [
    "Running Gemini web search...",
    `elapsed: ${elapsedSeconds}s`,
    `searches: ${counters.searches}`,
    `last action: ${counters.lastAction}`
  ].join("\n");
}

function normalizeConfidence(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }

  if (typeof value === "string") {
    const maybeNumber = Number(value.trim());
    if (Number.isFinite(maybeNumber)) {
      return Math.max(0, Math.min(1, maybeNumber));
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "high") return 0.85;
    if (normalized === "medium") return 0.65;
    if (normalized === "low") return 0.4;
  }

  return null;
}

export function coerceStructuredResult(value) {
  if (!value || typeof value !== "object") return null;

  const answerRaw =
    typeof value.answer === "string"
      ? value.answer
      : typeof value.result === "string"
        ? value.result
        : "";

  const asOfRaw =
    typeof value.as_of === "string"
      ? value.as_of
      : typeof value.asOf === "string"
        ? value.asOf
        : "";

  const notesRaw = typeof value.notes === "string" ? value.notes : "";
  const confidence = normalizeConfidence(value.confidence);
  const sourcesRaw = Array.isArray(value.sources)
    ? value.sources
    : Array.isArray(value.references)
      ? value.references
      : [];

  const answer = answerRaw.trim();
  const as_of = asOfRaw.trim();
  const notes = notesRaw.trim();

  if (!answer) return null;

  return {
    answer,
    as_of,
    ...(confidence !== null ? { confidence } : {}),
    sources: normalizeSources(sourcesRaw),
    notes
  };
}

export function deriveStructuredFromText(text, { asOfPeriod, asOfYear, maxSources }) {
  if (typeof text !== "string" || !text.trim()) return null;

  const withoutFence = text
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const lines = withoutFence
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return null;

  const answer = lines.find((line) => !/^sources?:/i.test(line)) || lines[0];
  if (!answer) return null;

  const detectedSources = normalizeSources(extractUrls(withoutFence), maxSources);

  return {
    answer,
    as_of: `${normalizeAsOfPeriod(asOfPeriod)} ${asOfYear}`,
    sources: detectedSources,
    notes: "Derived from non-JSON Gemini response."
  };
}

export function parseGeminiStreamEvents(stdout) {
  const lines = typeof stdout === "string" ? stdout.split(/\r?\n/) : [];
  const events = [];
  const toolUses = [];
  const toolResults = [];
  const errors = [];
  const assistantParts = [];
  let init = null;
  let finalResult = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    events.push(event);

    if (event.type === "init") init = event;
    if (event.type === "result") finalResult = event;

    if (event.type === "error") {
      errors.push(event);
      continue;
    }

    if (event.type === "tool_use") {
      toolUses.push(event);
      continue;
    }

    if (event.type === "tool_result") {
      toolResults.push(event);
      continue;
    }

    if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") {
      assistantParts.push(event.content);
    }
  }

  return {
    events,
    init,
    toolUses,
    toolResults,
    errors,
    finalResult,
    assistantText: assistantParts.join("")
  };
}
