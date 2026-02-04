import type {
  Api,
  AssistantMessageEventStream as AssistantMessageEventStreamType,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "@mariozechner/pi-ai";
import {
  AssistantMessageEventStream,
  getEnvApiKey,
  registerApiProvider,
  supportsXhigh,
} from "@mariozechner/pi-ai";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "@mariozechner/pi-ai/dist/providers/openai-responses-shared.js";
import {
  buildBaseOptions,
  clampReasoning,
} from "@mariozechner/pi-ai/dist/providers/simple-options.js";

type ResponseStream = AsyncIterable<{
  type?: string;
  [key: string]: unknown;
}>;

const OPENAI_TOOL_CALL_PROVIDERS = new Set([
  "openai",
  "openai-codex",
  "opencode",
  "openai-codex-apikey",
]);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function resolveResponsesUrl(baseUrl: string): string {
  return new URL("responses", normalizeBaseUrl(baseUrl)).toString();
}

function resolveCacheRetention(cacheRetention?: string): "short" | "long" | "none" {
  if (cacheRetention === "none" || cacheRetention === "short" || cacheRetention === "long") {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

function getPromptCacheRetention(baseUrl: string, cacheRetention: "short" | "long" | "none") {
  if (cacheRetention !== "long") {
    return undefined;
  }
  return baseUrl.includes("api.openai.com") ? "24h" : undefined;
}

async function* parseSseEvents(body: ReadableStream<Uint8Array>): ResponseStream {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = function* (): Generator<unknown> {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    if (data.trim() === "[DONE]") {
      return;
    }
    try {
      yield JSON.parse(data);
    } catch (error) {
      throw new Error(`Failed to parse SSE payload: ${String(error)}`);
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line === "") {
        for (const event of flush()) {
          yield event as { type?: string };
        }
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      idx = buffer.indexOf("\n");
    }
  }

  if (buffer.trim() !== "") {
    const line = buffer.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  for (const event of flush()) {
    yield event as { type?: string };
  }
}

function buildParams(model: Model<Api>, context: Context, options?: Record<string, unknown>) {
  const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
    includeSystemPrompt: false,
  });
  const cacheRetention = resolveCacheRetention(
    (options as { cacheRetention?: string } | undefined)?.cacheRetention,
  );
  const baseUrl = model.baseUrl ?? "";
  const params: Record<string, unknown> = {
    model: model.id,
    input: messages,
    stream: true,
    instructions: context.systemPrompt || "You are a helpful assistant.",
    prompt_cache_key:
      cacheRetention === "none"
        ? undefined
        : (options as { sessionId?: string } | undefined)?.sessionId,
    prompt_cache_retention: getPromptCacheRetention(baseUrl, cacheRetention),
  };

  const maxTokens = (options as { maxTokens?: number } | undefined)?.maxTokens;
  if (typeof maxTokens === "number" && baseUrl.includes("api.openai.com")) {
    params.max_output_tokens = maxTokens;
  }

  const temperature = (options as { temperature?: number } | undefined)?.temperature;
  if (typeof temperature === "number") {
    params.temperature = temperature;
  }

  const reasoningEffort = (options as { reasoningEffort?: string } | undefined)?.reasoningEffort;
  const reasoningSummary = (options as { reasoningSummary?: string } | undefined)?.reasoningSummary;
  if (reasoningEffort) {
    params.reasoning = { effort: reasoningEffort, summary: reasoningSummary ?? "auto" };
    params.include = ["reasoning.encrypted_content"];
  }

  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }

  return params;
}

const streamOpenAIResponsesInstructions: StreamFunction<"openai-responses-instructions"> = (
  model,
  context,
  options,
) => {
  const stream: AssistantMessageEventStreamType = new AssistantMessageEventStream();
  (async () => {
    const output = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    try {
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
      }
      if (!model.baseUrl) {
        throw new Error("Model baseUrl is required for openai-responses-instructions");
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...model.headers,
        ...(options?.headers ?? {}),
      };

      const params = buildParams(model, context, options);
      options?.onPayload?.(params);

      const response = await fetch(resolveResponsesUrl(model.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: options?.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI Responses request failed (${response.status}): ${errorText}`);
      }
      if (!response.body) {
        throw new Error("No response body");
      }

      const openaiStream = parseSseEvents(response.body);
      stream.push({ type: "start", partial: output });
      await processResponsesStream(openaiStream, output, stream, model, undefined);
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        delete (block as { index?: number }).index;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

const streamSimpleOpenAIResponsesInstructions: StreamFunction<"openai-responses-instructions"> = (
  model,
  context,
  options,
) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  return streamOpenAIResponsesInstructions(model, context, {
    ...base,
    reasoningEffort,
  });
};

registerApiProvider({
  api: "openai-responses-instructions",
  stream: streamOpenAIResponsesInstructions,
  streamSimple: streamSimpleOpenAIResponsesInstructions,
});
