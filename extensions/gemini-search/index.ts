import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runGeminiSearch } from "../../lib/gemini-runner.mjs";

type RunParams = {
  question: string;
  as_of_period?: string;
  as_of_year?: number;
  model?: string;
  timeout_sec?: number;
  max_sources?: number;
  fail_on_command_event?: boolean;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "gemini_search",
    label: "Gemini Search",
    description:
      "Run Gemini CLI web search in non-interactive mode with stream telemetry. Returns answer + source URLs + progress + prompt visibility.",
    parameters: Type.Object({
      question: Type.String({ description: "Question to research" }),
      as_of_period: Type.Optional(Type.String({ description: "Time period: early|mid|late (default: early)" })),
      as_of_year: Type.Optional(Type.Number({ description: "Reference year for recency framing (default: current UTC year)" })),
      model: Type.Optional(Type.String({ description: "Optional Gemini model override" })),
      timeout_sec: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 180, max: 3600)" })),
      max_sources: Type.Optional(Type.Number({ description: "Maximum number of source URLs to return (default: 8)" })),
      fail_on_command_event: Type.Optional(
        Type.Boolean({
          description: "If true, fail when non-web tools are detected in stream events (default: false)"
        })
      )
    }),
    async execute(_toolCallId, params: RunParams, signal, onUpdate) {
      const result = await runGeminiSearch(params, {
        signal,
        onUpdate: (text: string) => {
          onUpdate?.({ content: [{ type: "text", text }] });
        }
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details
      };
    }
  });

  pi.registerCommand("gemini-search", {
    description: "Run Gemini-backed web search (usage: /gemini-search <question>)",
    handler: async (args, ctx) => {
      const question = args?.trim();
      if (!question) {
        ctx.ui.notify("Usage: /gemini-search <question>", "error");
        return;
      }

      ctx.ui.notify("Running Gemini search...", "info");
      const result = await runGeminiSearch({ question });

      if (!result.ok) {
        ctx.ui.notify(result.text, "error");
        return;
      }

      const searchPrompt = (result.details?.searchPrompt as string | undefined) || "";
      const commandText = searchPrompt
        ? `${result.text}\n\nPrompt used:\n${searchPrompt}`
        : result.text;

      ctx.ui.notify("Gemini search complete", "success");
      ctx.ui.setEditorText(commandText);
    }
  });
}
