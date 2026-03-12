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

type GemmaInstructionEntry = {
  role: "system" | "developer";
  text: string;
};

function normalizeInstructionText(content: unknown): string | null {
  if (typeof content === "string") {
    const text = content.trim();
    return text.length > 0 ? text : null;
  }

  if (Array.isArray(content)) {
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

    return parts.length > 0 ? parts.join("\n").trim() : null;
  }

  if (!content || typeof content !== "object") {
    return null;
  }

  const record = content as Record<string, unknown>;
  if (Array.isArray(record.parts)) {
    return normalizeInstructionText(record.parts);
  }

  if (typeof record.text === "string") {
    const text = record.text.trim();
    return text.length > 0 ? text : null;
  }

  if (typeof record.content === "string") {
    const text = record.content.trim();
    return text.length > 0 ? text : null;
  }

  return null;
}

function buildGemmaInstructionBlock(entries: GemmaInstructionEntry[]): string | null {
  if (entries.length === 0) {
    return null;
  }

  return entries
    .map(({ role, text }) => {
      const tag = role === "system" ? "system_instruction" : "developer_instruction";
      return `<${tag}>\n${text}\n</${tag}>`;
    })
    .join("\n\n");
}

function prependGemmaChatInstruction(content: unknown, instructionBlock: string): unknown {
  if (Array.isArray(content)) {
    return [{ type: "text", text: instructionBlock }, ...content];
  }

  if (typeof content === "string") {
    return content.trim().length > 0
      ? `${instructionBlock}\n\n${content}`
      : instructionBlock;
  }

  return instructionBlock;
}

function prependGemmaResponsesInstruction(content: unknown, instructionBlock: string): unknown {
  if (Array.isArray(content)) {
    return [{ type: "input_text", text: instructionBlock }, ...content];
  }

  if (typeof content === "string") {
    return content.trim().length > 0
      ? `${instructionBlock}\n\n${content}`
      : instructionBlock;
  }

  return [{ type: "input_text", text: instructionBlock }];
}

function collectGemmaTopLevelInstructions(body: Record<string, unknown>): GemmaInstructionEntry[] {
  const entries: GemmaInstructionEntry[] = [];

  const developerInstruction = normalizeInstructionText(body.instructions);
  if (developerInstruction) {
    entries.push({ role: "developer", text: developerInstruction });
  }

  const systemInstruction = normalizeInstructionText(body.systemInstruction ?? body.system_instruction);
  if (systemInstruction) {
    entries.push({ role: "system", text: systemInstruction });
  }

  return entries;
}

function mergeGemmaChatMessages(
  messages: unknown,
  extraEntries: GemmaInstructionEntry[] = []
): unknown {
  const entries = [...extraEntries];

  if (!Array.isArray(messages)) {
    const instructionBlock = buildGemmaInstructionBlock(entries);
    if (!instructionBlock) {
      return messages;
    }

    return [{ role: "user", content: instructionBlock }];
  }

  const keptMessages: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";

    if (role === "system" || role === "developer") {
      const text = normalizeInstructionText(record.content);
      if (text) {
        entries.push({ role, text });
      }
      continue;
    }

    keptMessages.push(record);
  }

  const instructionBlock = buildGemmaInstructionBlock(entries);
  if (!instructionBlock) {
    return keptMessages.length > 0 ? keptMessages : messages;
  }

  const nextMessages = keptMessages.map((message) => ({ ...message }));
  const firstUserIndex = nextMessages.findIndex((message) => {
    const role = typeof message.role === "string" ? message.role : "user";
    return role === "user";
  });

  if (firstUserIndex >= 0) {
    nextMessages[firstUserIndex] = {
      ...nextMessages[firstUserIndex],
      content: prependGemmaChatInstruction(nextMessages[firstUserIndex].content, instructionBlock),
    };
    return nextMessages;
  }

  return [{ role: "user", content: instructionBlock }, ...nextMessages];
}

function mergeGemmaResponsesInput(
  input: unknown,
  extraEntries: GemmaInstructionEntry[] = []
): unknown {
  const entries = [...extraEntries];

  if (typeof input === "string") {
    const instructionBlock = buildGemmaInstructionBlock(entries);
    if (!instructionBlock) {
      return input;
    }
    return `${instructionBlock}\n\n${input}`;
  }

  if (!Array.isArray(input)) {
    const instructionBlock = buildGemmaInstructionBlock(entries);
    if (!instructionBlock) {
      return input;
    }
    return [{
      role: "user",
      content: [{ type: "input_text", text: instructionBlock }],
    }];
  }

  const keptInputs: Record<string, unknown>[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";

    if (role === "system" || role === "developer") {
      const text = normalizeInstructionText(record.content);
      if (text) {
        entries.push({ role, text });
      }
      continue;
    }

    keptInputs.push(record);
  }

  const instructionBlock = buildGemmaInstructionBlock(entries);
  if (!instructionBlock) {
    return keptInputs.length > 0 ? keptInputs : input;
  }

  const nextInput = keptInputs.map((item) => ({ ...item }));
  const firstUserIndex = nextInput.findIndex((item) => {
    const role = typeof item.role === "string" ? item.role : "user";
    return role === "user";
  });

  if (firstUserIndex >= 0) {
    nextInput[firstUserIndex] = {
      ...nextInput[firstUserIndex],
      content: prependGemmaResponsesInstruction(nextInput[firstUserIndex].content, instructionBlock),
    };
    return nextInput;
  }

  return [{
    role: "user",
    content: [{ type: "input_text", text: instructionBlock }],
  }, ...nextInput];
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

function buildUsageFromChat(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const usage = (payload as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const input = typeof (usage as Record<string, unknown>).prompt_tokens === "number"
    ? (usage as Record<string, unknown>).prompt_tokens as number
    : 0;
  const output = typeof (usage as Record<string, unknown>).completion_tokens === "number"
    ? (usage as Record<string, unknown>).completion_tokens as number
    : 0;
  const total = typeof (usage as Record<string, unknown>).total_tokens === "number"
    ? (usage as Record<string, unknown>).total_tokens as number
    : input + output;

  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total,
  };
}

function extractChatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const body = payload as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") {
    return "";
  }

  const choice = first as Record<string, unknown>;
  const message = choice.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => typeof item.text === "string" ? item.text : "")
        .filter(Boolean)
        .join("\n");
    }
  }

  if (typeof choice.text === "string") {
    return choice.text;
  }

  return "";
}

function toChatMessagesFromClaudeRequest(
  messages: unknown,
  system: unknown
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const result: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const systemText = normalizeInstructionText(system);
  if (systemText) {
    result.push({
      role: "system",
      content: systemText,
    });
  }

  if (!Array.isArray(messages)) {
    return result.length > 0
      ? result
      : [{ role: "user", content: CLI_DETECT_PROMPT }];
  }

  for (const item of messages) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";
    const content = normalizeInstructionText(record.content)?.trim();
    if (!content) {
      continue;
    }

    result.push({
      role: role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  return result.length > 0
    ? result
    : [{ role: "user", content: CLI_DETECT_PROMPT }];
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

function buildClaudeMessage(modelName: string, text: string, usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}) {
  const message = {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: modelName,
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };

  if (usage) {
    return {
      ...message,
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      },
    };
  }

  return message;
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

function createClaudeEvent(event: Record<string, unknown>): string {
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

export function isGemmaModelName(modelName: string): boolean {
  return getActualModelName(modelName).toLowerCase().startsWith("gemma");
}

export function sanitizeOpenAiChatBodyForGemma(body: Record<string, unknown>): Record<string, unknown> {
  const topLevelInstructions = collectGemmaTopLevelInstructions(body);
  const sanitizedBody: Record<string, unknown> = { ...body };
  sanitizedBody.messages = mergeGemmaChatMessages(body.messages, topLevelInstructions);
  delete sanitizedBody.instructions;
  delete sanitizedBody.systemInstruction;
  delete sanitizedBody.system_instruction;
  return sanitizedBody;
}

export function sanitizeOpenAiResponsesBodyForGemma(body: Record<string, unknown>): Record<string, unknown> {
  const topLevelInstructions = collectGemmaTopLevelInstructions(body);
  const sanitizedBody: Record<string, unknown> = { ...body };
  sanitizedBody.input = mergeGemmaResponsesInput(body.input, topLevelInstructions);
  delete sanitizedBody.instructions;
  delete sanitizedBody.systemInstruction;
  delete sanitizedBody.system_instruction;
  return sanitizedBody;
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

export function buildChatBodyFromClaudeRequest(
  body: Record<string, unknown>,
  modelName: string
): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: modelName,
    messages: toChatMessagesFromClaudeRequest(body.messages, body.system),
    stream: body.stream === true,
  };

  const maxTokens = pickNumeric(body.max_tokens, 1024) ?? 1024;
  requestBody.max_tokens = maxTokens;

  if ("temperature" in body) requestBody.temperature = body.temperature;
  if ("top_p" in body) requestBody.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    requestBody.stop = body.stop_sequences;
  }

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

export function buildChatCompletionFromText(modelName: string, text: string) {
  return buildChatCompletion(modelName, text);
}

export function buildChatCompletionFromGemini(payload: unknown, modelName: string) {
  return buildChatCompletion(modelName, extractGeminiText(payload), buildUsageFromGemini(payload));
}

export function buildResponsesFromClaude(payload: unknown, modelName: string) {
  return buildResponses(modelName, extractClaudeText(payload), buildUsageFromClaude(payload));
}

export function buildResponsesFromText(modelName: string, text: string) {
  return buildResponses(modelName, text);
}

export function buildResponsesFromGemini(payload: unknown, modelName: string) {
  return buildResponses(modelName, extractGeminiText(payload), buildUsageFromGemini(payload));
}

export function buildClaudeMessageFromText(modelName: string, text: string) {
  return buildClaudeMessage(modelName, text);
}

export function buildClaudeMessageFromChat(payload: unknown, modelName: string) {
  return buildClaudeMessage(modelName, extractChatText(payload), buildUsageFromChat(payload));
}

export function looksLikeSsePayload(text: string): boolean {
  return /^\s*data:\s*/m.test(text);
}

function parseSseEvents(sseText: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") {
      continue;
    }

    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      events.push(event);
    } catch {
    }
  }

  return events;
}

export function extractTextFromChatSse(sseText: string): string {
  let text = "";

  for (const event of parseSseEvents(sseText)) {
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const firstChoice = choices[0];
    if (!firstChoice || typeof firstChoice !== "object") {
      continue;
    }

    const choice = firstChoice as Record<string, unknown>;
    const delta = choice.delta;
    if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).content === "string") {
      text += (delta as Record<string, unknown>).content as string;
      continue;
    }

    const message = choice.message;
    if (message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string") {
      text = (message as Record<string, unknown>).content as string;
      continue;
    }

    if (typeof choice.text === "string" && choice.text.length > 0) {
      text = choice.text;
    }
  }

  return text;
}

export function extractTextFromResponsesSse(sseText: string): string {
  let text = "";

  for (const event of parseSseEvents(sseText)) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      continue;
    }

    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      text = event.text;
      continue;
    }

    const response = event.response;
    if (
      event.type === "response.completed" &&
      response &&
      typeof response === "object" &&
      typeof (response as Record<string, unknown>).output_text === "string"
    ) {
      text = (response as Record<string, unknown>).output_text as string;
    }
  }

  return text;
}

export function extractTextFromClaudeSse(sseText: string): string {
  let text = "";

  for (const event of parseSseEvents(sseText)) {
    if (
      event.type === "content_block_delta" &&
      event.delta &&
      typeof event.delta === "object" &&
      (event.delta as Record<string, unknown>).type === "text_delta" &&
      typeof (event.delta as Record<string, unknown>).text === "string"
    ) {
      text += (event.delta as Record<string, unknown>).text as string;
    }
  }

  return text;
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

export function convertChatStreamToClaudeStream(upstream: Response, modelName: string): Response {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return new Response("Upstream response has no body", { status: 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      let started = false;
      let blockStarted = false;
      let completed = false;

      const sendStarted = () => {
        if (started) return;
        started = true;
        controller.enqueue(
          encoder.encode(
            createClaudeEvent({
              type: "message_start",
              message: {
                id: `msg_${Date.now()}`,
                type: "message",
                role: "assistant",
                model: modelName,
                stop_reason: null,
                stop_sequence: null,
                content: [],
              },
            })
          )
        );
      };

      const sendBlockStarted = () => {
        if (blockStarted) return;
        blockStarted = true;
        sendStarted();
        controller.enqueue(
          encoder.encode(
            createClaudeEvent({
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "text",
                text: "",
              },
            })
          )
        );
      };

      const finish = () => {
        if (completed) return;
        completed = true;
        sendBlockStarted();
        controller.enqueue(encoder.encode(createClaudeEvent({
          type: "content_block_stop",
          index: 0,
        })));
        controller.enqueue(encoder.encode(createClaudeEvent({
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          usage: {
            output_tokens: 0,
          },
        })));
        controller.enqueue(encoder.encode(createClaudeEvent({
          type: "message_stop",
        })));
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
              const choices = Array.isArray(event.choices) ? event.choices : [];
              const firstChoice = choices[0];
              if (!firstChoice || typeof firstChoice !== "object") {
                continue;
              }

              const choice = firstChoice as Record<string, unknown>;
              const delta = choice.delta;
              if (delta && typeof delta === "object") {
                const deltaText = typeof (delta as Record<string, unknown>).content === "string"
                  ? (delta as Record<string, unknown>).content as string
                  : "";

                if (deltaText) {
                  sendBlockStarted();
                  controller.enqueue(
                    encoder.encode(
                      createClaudeEvent({
                        type: "content_block_delta",
                        index: 0,
                        delta: {
                          type: "text_delta",
                          text: deltaText,
                        },
                      })
                    )
                  );
                }
              }

              if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
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

export function createSyntheticClaudeStreamResponse(text: string, modelName: string): Response {
  return createSyntheticStreamResponse([
    createClaudeEvent({
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelName,
        stop_reason: null,
        stop_sequence: null,
        content: [],
      },
    }),
    createClaudeEvent({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      },
    }),
    ...(text
      ? [createClaudeEvent({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text,
          },
        })]
      : []),
    createClaudeEvent({
      type: "content_block_stop",
      index: 0,
    }),
    createClaudeEvent({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: 0,
      },
    }),
    createClaudeEvent({
      type: "message_stop",
    }),
  ]);
}

export function extractTextFromGemini(payload: unknown): string {
  return extractGeminiText(payload);
}
