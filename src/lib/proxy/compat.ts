const CLI_DETECT_PROMPT = process.env.DETECT_PROMPT || "1+1=2? yes or no";

function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return CLI_DETECT_PROMPT;
  }

  const parts = content.flatMap((item) => {
    if (typeof item === "string") {
      return item;
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.length > 0) {
      return record.text;
    }

    if (typeof record.content === "string" && record.content.length > 0) {
      return record.content;
    }

    return [];
  });

  return parts.length > 0 ? parts.join("\n") : CLI_DETECT_PROMPT;
}

function toClaudeMessages(messages: unknown): {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system?: string;
} {
  if (!Array.isArray(messages)) {
    return {
      messages: [{ role: "user", content: CLI_DETECT_PROMPT }],
    };
  }

  const systemParts: string[] = [];
  const result: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const item of messages) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";
    const content = normalizeTextContent(record.content).trim();
    if (!content) {
      continue;
    }

    if (role === "system") {
      systemParts.push(content);
      continue;
    }

    result.push({
      role: role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  if (result.length === 0) {
    result.push({ role: "user", content: CLI_DETECT_PROMPT });
  }

  return {
    messages: result,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

function toGeminiMessages(messages: unknown): {
  contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
} {
  if (!Array.isArray(messages)) {
    return {
      contents: [{ role: "user", parts: [{ text: CLI_DETECT_PROMPT }] }],
    };
  }

  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const item of messages) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";
    const content = normalizeTextContent(record.content).trim();
    if (!content) {
      continue;
    }

    if (role === "system") {
      systemParts.push(content);
      continue;
    }

    contents.push({
      role: role === "assistant" ? "model" : "user",
      parts: [{ text: content }],
    });
  }

  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: CLI_DETECT_PROMPT }] });
  }

  return {
    contents,
    systemInstruction: systemParts.length > 0
      ? { parts: [{ text: systemParts.join("\n\n") }] }
      : undefined,
  };
}

function toResponsesMessages(input: unknown): Array<{ role: string; content: unknown }> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [{ role: "user", content: CLI_DETECT_PROMPT }];
  }

  const messages = input
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      role: typeof item.role === "string" ? item.role : "user",
      content: item.content,
    }));

  return messages.length > 0 ? messages : [{ role: "user", content: CLI_DETECT_PROMPT }];
}

function pickNumeric(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function extractClaudeText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const body = payload as Record<string, unknown>;
  const content = Array.isArray(body.content) ? body.content : [];
  const texts = content
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string);

  return texts.join("\n");
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const body = payload as Record<string, unknown>;
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const first = candidates[0];
  if (!first || typeof first !== "object") {
    return "";
  }

  const content = (first as Record<string, unknown>).content;
  if (!content || typeof content !== "object") {
    return "";
  }

  const parts: unknown[] = Array.isArray((content as Record<string, unknown>).parts)
    ? (content as Record<string, unknown>).parts as unknown[]
    : [];

  return parts
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function buildUsageFromClaude(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const input = typeof (usage as Record<string, unknown>).input_tokens === "number"
    ? (usage as Record<string, unknown>).input_tokens as number
    : 0;
  const output = typeof (usage as Record<string, unknown>).output_tokens === "number"
    ? (usage as Record<string, unknown>).output_tokens as number
    : 0;

  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

function buildUsageFromGemini(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const usage = (payload as Record<string, unknown>).usageMetadata;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const input = typeof (usage as Record<string, unknown>).promptTokenCount === "number"
    ? (usage as Record<string, unknown>).promptTokenCount as number
    : 0;
  const output = typeof (usage as Record<string, unknown>).candidatesTokenCount === "number"
    ? (usage as Record<string, unknown>).candidatesTokenCount as number
    : 0;
  const total = typeof (usage as Record<string, unknown>).totalTokenCount === "number"
    ? (usage as Record<string, unknown>).totalTokenCount as number
    : input + output;

  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
  };
}

function buildChatCompletion(modelName: string, text: string, usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

function buildResponses(modelName: string, text: string, usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) {
  const id = `resp_${Date.now()}`;
  return {
    id,
    object: "response",
    created_at: new Date().toISOString(),
    model: modelName,
    status: "completed",
    output: [
      {
        id: `${id}_output_0`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    output_text: text,
    usage: usage
      ? {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        }
      : undefined,
  };
}

function createChatCompletionChunk(
  modelName: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

function createResponsesEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function createSyntheticStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function getActualModelName(modelName: string): string {
  const slashIndex = modelName.indexOf("/");
  return slashIndex > 0 ? modelName.slice(slashIndex + 1) : modelName;
}

export function isClaudeModelName(modelName: string): boolean {
  return getActualModelName(modelName).toLowerCase().includes("claude");
}

export function isGeminiModelName(modelName: string): boolean {
  return getActualModelName(modelName).toLowerCase().includes("gemini");
}

export function buildClaudeBodyFromChatRequest(
  body: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const { messages, max_tokens, max_completion_tokens } = body;
  const converted = toClaudeMessages(messages);
  const requestBody: Record<string, unknown> = {
    model: modelName,
    messages: converted.messages,
    max_tokens: pickNumeric(max_completion_tokens, max_tokens, 1024) ?? 1024,
    stream: body.stream === true,
  };

  if (converted.system) requestBody.system = converted.system;
  if ("temperature" in body) requestBody.temperature = body.temperature;
  if ("top_p" in body) requestBody.top_p = body.top_p;
  if ("tools" in body) requestBody.tools = body.tools;
  if ("tool_choice" in body) requestBody.tool_choice = body.tool_choice;

  return requestBody;
}

export function buildClaudeBodyFromResponsesRequest(
  body: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const converted = toClaudeMessages(toResponsesMessages(body.input));
  const requestBody: Record<string, unknown> = {
    model: modelName,
    messages: converted.messages,
    max_tokens: pickNumeric(body.max_output_tokens, 1024) ?? 1024,
    stream: body.stream !== false,
  };

  if (converted.system) requestBody.system = converted.system;
  if ("temperature" in body) requestBody.temperature = body.temperature;
  if ("top_p" in body) requestBody.top_p = body.top_p;
  if ("tools" in body) requestBody.tools = body.tools;
  if ("tool_choice" in body) requestBody.tool_choice = body.tool_choice;

  return requestBody;
}

export function buildGeminiBodyFromChatRequest(body: Record<string, unknown>): Record<string, unknown> {
  const converted = toGeminiMessages(body.messages);
  const requestBody: Record<string, unknown> = {
    contents: converted.contents,
    generationConfig: {
      maxOutputTokens: pickNumeric(body.max_completion_tokens, body.max_tokens, 1024) ?? 1024,
    },
  };

  if (converted.systemInstruction) {
    requestBody.systemInstruction = converted.systemInstruction;
  }

  if ("temperature" in body) {
    (requestBody.generationConfig as Record<string, unknown>).temperature = body.temperature;
  }
  if ("top_p" in body) {
    (requestBody.generationConfig as Record<string, unknown>).topP = body.top_p;
  }

  return requestBody;
}

export function buildGeminiBodyFromResponsesRequest(body: Record<string, unknown>): Record<string, unknown> {
  const converted = toGeminiMessages(toResponsesMessages(body.input));
  const requestBody: Record<string, unknown> = {
    contents: converted.contents,
    generationConfig: {
      maxOutputTokens: pickNumeric(body.max_output_tokens, 1024) ?? 1024,
    },
  };

  if (converted.systemInstruction) {
    requestBody.systemInstruction = converted.systemInstruction;
  }

  if ("temperature" in body) {
    (requestBody.generationConfig as Record<string, unknown>).temperature = body.temperature;
  }
  if ("top_p" in body) {
    (requestBody.generationConfig as Record<string, unknown>).topP = body.top_p;
  }

  return requestBody;
}

export function buildChatCompletionFromClaude(payload: unknown, modelName: string) {
  return buildChatCompletion(modelName, extractClaudeText(payload), buildUsageFromClaude(payload));
}

export function buildChatCompletionFromGemini(payload: unknown, modelName: string) {
  return buildChatCompletion(modelName, extractGeminiText(payload), buildUsageFromGemini(payload));
}

export function buildResponsesFromClaude(payload: unknown, modelName: string) {
  return buildResponses(modelName, extractClaudeText(payload), buildUsageFromClaude(payload));
}

export function buildResponsesFromGemini(payload: unknown, modelName: string) {
  return buildResponses(modelName, extractGeminiText(payload), buildUsageFromGemini(payload));
}

export function convertClaudeStreamToChatStream(upstream: Response, modelName: string): Response {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let roleSent = false;
      let completed = false;

      const sendRole = () => {
        if (roleSent) return;
        roleSent = true;
        controller.enqueue(encoder.encode(createChatCompletionChunk(modelName, { role: "assistant" })));
      };

      const finish = () => {
        if (completed) return;
        completed = true;
        sendRole();
        controller.enqueue(encoder.encode(createChatCompletionChunk(modelName, {}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              if (
                event.type === "content_block_delta" &&
                event.delta &&
                typeof event.delta === "object" &&
                (event.delta as Record<string, unknown>).type === "text_delta" &&
                typeof (event.delta as Record<string, unknown>).text === "string"
              ) {
                sendRole();
                controller.enqueue(
                  encoder.encode(
                    createChatCompletionChunk(modelName, {
                      content: (event.delta as Record<string, unknown>).text,
                    })
                  )
                );
              } else if (event.type === "message_stop") {
                finish();
                return;
              }
            } catch {
            }
          }
        }

        finish();
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function convertClaudeStreamToResponsesStream(upstream: Response, modelName: string): Response {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `resp_${Date.now()}`;
  const outputItemId = `${responseId}_output_0`;

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let emittedText = "";
      let created = false;
      let completed = false;

      const sendCreated = () => {
        if (created) return;
        created = true;
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.created",
              response: {
                id: responseId,
                object: "response",
                created_at: new Date().toISOString(),
                model: modelName,
                status: "in_progress",
                output: [],
              },
            })
          )
        );
      };

      const finish = () => {
        if (completed) return;
        completed = true;
        sendCreated();
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.output_text.done",
              item_id: outputItemId,
              output_index: 0,
              content_index: 0,
              text: emittedText,
            })
          )
        );
        controller.enqueue(
          encoder.encode(
            createResponsesEvent({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                created_at: new Date().toISOString(),
                model: modelName,
                status: "completed",
                output: [
                  {
                    id: outputItemId,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: emittedText,
                        annotations: [],
                      },
                    ],
                  },
                ],
                output_text: emittedText,
              },
            })
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw || raw === "[DONE]") continue;

            try {
              const event = JSON.parse(raw) as Record<string, unknown>;
              if (
                event.type === "content_block_delta" &&
                event.delta &&
                typeof event.delta === "object" &&
                (event.delta as Record<string, unknown>).type === "text_delta" &&
                typeof (event.delta as Record<string, unknown>).text === "string"
              ) {
                const text = (event.delta as Record<string, unknown>).text as string;
                sendCreated();
                emittedText += text;
                controller.enqueue(
                  encoder.encode(
                    createResponsesEvent({
                      type: "response.output_text.delta",
                      item_id: outputItemId,
                      output_index: 0,
                      content_index: 0,
                      delta: text,
                    })
                  )
                );
              } else if (event.type === "message_stop") {
                finish();
                return;
              }
            } catch {
            }
          }
        }

        finish();
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function createSyntheticChatStreamResponse(text: string, modelName: string): Response {
  return createSyntheticStreamResponse([
    createChatCompletionChunk(modelName, { role: "assistant" }),
    ...(text ? [createChatCompletionChunk(modelName, { content: text })] : []),
    createChatCompletionChunk(modelName, {}, "stop"),
    "data: [DONE]\n\n",
  ]);
}

export function createSyntheticResponsesStreamResponse(text: string, modelName: string): Response {
  const responseId = `resp_${Date.now()}`;
  const outputItemId = `${responseId}_output_0`;

  return createSyntheticStreamResponse([
    createResponsesEvent({
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        created_at: new Date().toISOString(),
        model: modelName,
        status: "in_progress",
        output: [],
      },
    }),
    ...(text
      ? [
          createResponsesEvent({
            type: "response.output_text.delta",
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          }),
        ]
      : []),
    createResponsesEvent({
      type: "response.output_text.done",
      item_id: outputItemId,
      output_index: 0,
      content_index: 0,
      text,
    }),
    createResponsesEvent({
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        created_at: new Date().toISOString(),
        model: modelName,
        status: "completed",
        output: [
          {
            id: outputItemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text,
                annotations: [],
              },
            ],
          },
        ],
        output_text: text,
      },
    }),
    "data: [DONE]\n\n",
  ]);
}

export function extractTextFromGemini(payload: unknown): string {
  return extractGeminiText(payload);
}
