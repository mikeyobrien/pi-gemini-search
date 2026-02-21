import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_SOURCES,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  PROGRESS_HEARTBEAT_MS,
  PROGRESS_MIN_INTERVAL_MS,
  buildGeminiPrompt,
  coerceStructuredResult,
  createProgressCounters,
  deriveStructuredFromText,
  extractUrls,
  formatProgressStatus,
  normalizeAsOfPeriod,
  normalizeSources,
  parseGeminiStreamEvents,
  parseJsonObject,
  updateProgressCountersFromEvent
} from "./gemini-core.mjs";

export {
  DEFAULT_MAX_SOURCES,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  PROGRESS_HEARTBEAT_MS,
  PROGRESS_MIN_INTERVAL_MS,
  buildGeminiPrompt,
  coerceStructuredResult,
  createProgressCounters,
  formatProgressStatus,
  normalizeAsOfPeriod,
  normalizeSources,
  parseGeminiStreamEvents,
  parseJsonObject,
  updateProgressCountersFromEvent
};

export async function runGeminiSearch(
  params,
  options = {
    onUpdate: undefined,
    signal: undefined
  }
) {
  const question = String(params.question || "").trim();
  if (!question) {
    return {
      ok: false,
      text: "gemini_search error: question is required",
      details: { error: true, reason: "missing_question" }
    };
  }

  const asOfYear = Number.isFinite(params.as_of_year) ? Number(params.as_of_year) : new Date().getUTCFullYear();
  const asOfPeriod = normalizeAsOfPeriod(params.as_of_period);
  const maxSources = Math.max(1, Math.min(params.max_sources ?? DEFAULT_MAX_SOURCES, 20));
  const timeoutSec = Math.max(30, Math.min(params.timeout_sec ?? DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC));
  const failOnCommandEvent = params.fail_on_command_event === true;
  const startedAt = Date.now();
  const progress = createProgressCounters();
  const searchPrompt = buildGeminiPrompt({ question, asOfPeriod, asOfYear });

  const emit = options?.onUpdate;
  let lastProgressEmitAt = 0;
  const emitProgress = (force = false) => {
    if (!emit) return;
    const now = Date.now();
    if (!force && now - lastProgressEmitAt < PROGRESS_MIN_INTERVAL_MS) return;
    lastProgressEmitAt = now;
    emit(formatProgressStatus(progress, startedAt));
  };

  const tempDir = await mkdtemp(join(tmpdir(), "pi-gemini-search-"));
  const workspaceDir = join(tempDir, "workspace");
  const geminiDir = join(workspaceDir, ".gemini");
  const settingsPath = join(geminiDir, "settings.json");

  try {
    await mkdir(geminiDir, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          tools: {
            core: ["google_web_search"]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const args = ["-p", searchPrompt, "--output-format", "stream-json"];
    if (params.model?.trim()) args.push("-m", params.model.trim());

    emitProgress(true);

    const child = spawn("gemini", args, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let timedOut = false;
    let aborted = false;

    const readStdoutLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const update = updateProgressCountersFromEvent(event, progress);
      if (update.changed) emitProgress();
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;

      let index = lineBuffer.indexOf("\n");
      while (index !== -1) {
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        readStdoutLine(line);
        index = lineBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const progressTimer = setInterval(() => emitProgress(true), PROGRESS_HEARTBEAT_MS);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      progress.lastAction = `timeout after ${timeoutSec}s`;
      emitProgress(true);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, timeoutSec * 1000);

    const abortListener = () => {
      aborted = true;
      progress.lastAction = "aborted";
      emitProgress(true);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    };

    if (options?.signal) {
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
    }

    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", (error) => reject(error));
      child.once("close", (code) => resolve(code ?? -1));
    }).finally(() => {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      if (options?.signal) options.signal.removeEventListener("abort", abortListener);
    });

    if (lineBuffer.trim()) readStdoutLine(lineBuffer);

    const telemetry = parseGeminiStreamEvents(stdout);
    emitProgress(true);

    const disallowedToolCount = telemetry.toolUses.filter((event) => event.tool_name !== "google_web_search").length;

    if (exitCode !== 0) {
      const reason = timedOut ? "timeout" : aborted ? "aborted" : "non_zero_exit";
      return {
        ok: false,
        text: `gemini_search error: gemini exited with code ${exitCode}`,
        details: {
          error: true,
          reason,
          exitCode,
          stderr,
          telemetry,
          searchPrompt,
          as_of_period: asOfPeriod,
          as_of_year: asOfYear,
          model: telemetry.init?.model || params.model || null,
          progress: {
            elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
            searches: progress.searches
          }
        }
      };
    }

    if (failOnCommandEvent && disallowedToolCount > 0) {
      return {
        ok: false,
        text: "gemini_search policy error: non-web tools were used",
        details: {
          error: true,
          reason: "command_events_detected",
          disallowedToolCount,
          searchPrompt,
          as_of_period: asOfPeriod,
          as_of_year: asOfYear,
          model: telemetry.init?.model || params.model || null
        }
      };
    }

    const parsedJson = parseJsonObject(telemetry.assistantText);
    let structured = coerceStructuredResult(parsedJson);

    if (!structured) {
      structured = deriveStructuredFromText(telemetry.assistantText, {
        asOfPeriod,
        asOfYear,
        maxSources
      });
    }

    if (!structured) {
      return {
        ok: false,
        text: "gemini_search error: no parsable final output",
        details: {
          error: true,
          reason: "no_final_output",
          telemetry,
          rawAssistantText: telemetry.assistantText.slice(0, 4000),
          searchPrompt,
          as_of_period: asOfPeriod,
          as_of_year: asOfYear,
          model: telemetry.init?.model || params.model || null
        }
      };
    }

    const sourceCandidates = structured.sources.length
      ? structured.sources
      : extractUrls(telemetry.assistantText);
    structured.sources = normalizeSources(sourceCandidates, maxSources);

    if (!structured.as_of) structured.as_of = `${asOfPeriod} ${asOfYear}`;
    if (!structured.notes) structured.notes = "";

    const sourceLines = structured.sources.map((source, i) => `${i + 1}. ${source}`);
    const content = [
      structured.answer,
      "",
      `As of: ${structured.as_of}`,
      ...(typeof structured.confidence === "number" ? [`Confidence: ${structured.confidence}`] : []),
      "",
      "Sources:",
      ...(sourceLines.length ? sourceLines : ["(none)"]),
      "",
      "Progress:",
      `- elapsed: ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`,
      `- searches: ${progress.searches}`
    ];

    if (structured.notes) content.push("", `Notes: ${structured.notes}`);

    const resolvedModel = telemetry.init?.model || params.model || null;
    const searchToolUses = telemetry.toolUses.filter((event) => event.tool_name === "google_web_search");
    const searchToolIds = new Set(searchToolUses.map((event) => event.tool_id));
    const searchToolResults = telemetry.toolResults.filter((event) => searchToolIds.has(event.tool_id));

    return {
      ok: true,
      text: content.join("\n"),
      details: {
        query: question,
        as_of_period: asOfPeriod,
        as_of_year: asOfYear,
        model: resolvedModel,
        searchPrompt,
        promptVisibility: {
          searchPrompt,
          as_of_period: asOfPeriod,
          as_of_year: asOfYear,
          model: resolvedModel
        },
        structured,
        telemetry: {
          searchToolUses,
          searchToolResults,
          finalResult: telemetry.finalResult,
          errors: telemetry.errors
        },
        progress: {
          elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
          searches: progress.searches
        }
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      text: `gemini_search error: ${message}`,
      details: {
        error: true,
        reason: "spawn_failure",
        message,
        progress: {
          elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
          searches: progress.searches
        }
      }
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
