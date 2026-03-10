type LogLevel = "warn" | "error";

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return fallback;
}

function writeLog(level: LogLevel, scope: string, error: unknown, fallback: string): void {
  const message = `${scope}: ${getErrorMessage(error, fallback)}`;
  if (level === "warn") {
    console.warn(message, error);
    return;
  }

  console.error(message, error);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function isClientStreamDisconnectError(error: unknown): boolean {
  const message = getErrorMessage(error, "").toLowerCase();

  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return (
    message.includes("controller is already closed") ||
    message.includes("readablestream is already closed") ||
    message.includes("stream is already closed") ||
    message.includes("stream is closed") ||
    message.includes("client disconnected") ||
    message.includes("the operation was aborted") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}

export function isExpectedCloseError(error: unknown): boolean {
  const message = getErrorMessage(error, "").toLowerCase();
  return (
    message.includes("closed") ||
    message.includes("close") ||
    message.includes("errored") ||
    message.includes("controller")
  );
}

export function logWarn(scope: string, error: unknown, fallback = "发生未知错误"): void {
  writeLog("warn", scope, error, fallback);
}

export function logError(scope: string, error: unknown, fallback = "发生未知错误"): void {
  writeLog("error", scope, error, fallback);
}

export function createAsyncErrorHandler(
  scope: string,
  level: LogLevel = "error",
  fallback = "后台任务执行失败"
): (error: unknown) => void {
  return (error: unknown) => {
    writeLog(level, scope, error, fallback);
  };
}
