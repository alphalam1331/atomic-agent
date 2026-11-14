/** The fixed Telegram delivery check exposed to Settings. No credentials cross IPC. */
export type TelegramTestResult =
  | { ok: true; status: "sent" }
  | { ok: false; error: string; code?: string; unsupported?: boolean };

export const TELEGRAM_TEST_PATH = "/api/telegram/test-notification";

export function readTelegramTestReply(status: number, text: string): TelegramTestResult {
  if (status === 404) {
    return { ok: false, unsupported: true, error: "Update Atomic Agent to send a test notification from Settings." };
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (status >= 200 && status < 300) {
    return obj?.ok === true && obj.status === "sent"
      ? { ok: true, status: "sent" }
      : { ok: false, error: "The agent did not confirm that the test notification was sent." };
  }
  const err = obj?.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : null;
  return {
    ok: false,
    error: typeof err?.message === "string" ? err.message : `Could not send the test notification (HTTP ${status}).`,
    ...(typeof err?.code === "string" ? { code: err.code } : {}),
  };
}
