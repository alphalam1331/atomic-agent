import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/** A manual, fixed-message delivery check to the running channel's paired owner. */
export function createTelegramTestNotificationHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const channel = ctx.runtime.telegramChannel;
    if (!channel) {
      sendError(res, 503, openaiError(
        "Telegram is not available in this agent.", "service_unavailable", null, "telegram_unavailable",
      ));
      return;
    }
    let delivery: Awaited<ReturnType<typeof channel.sendTestNotification>>;
    try {
      // No recipient or message is accepted from the request. The channel
      // checks its live state and owner, including a stop racing this call.
      delivery = await channel.sendTestNotification();
    } catch {
      // Never return an API exception: it may contain a token-bearing URL.
      delivery = "delivery_failed";
    }
    if (delivery === "channel_not_up") {
      sendError(res, 409, openaiError(
        "Telegram is not running. Add a bot token, turn Telegram on and restart the agent, then try again.",
        "invalid_request_error", null, "telegram_not_running",
      ));
    } else if (delivery === "not_paired") {
      sendError(res, 409, openaiError(
        "Pair your Telegram account before sending a test notification.",
        "invalid_request_error", null, "telegram_not_paired",
      ));
    } else if (delivery !== "sent") {
      sendError(res, 502, openaiError(
        "The test notification could not be delivered. Check that your bot is reachable and you have not blocked it, then try again.",
        "server_error", null, "telegram_delivery_failed",
      ));
    } else {
      sendJson(res, 200, { ok: true, status: "sent" });
    }
  };
}
