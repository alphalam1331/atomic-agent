import { EmailService, EmailServiceError } from "../email/email-service.js";
import {
  emailAccountStatus,
  EmailAccountInputError,
  removeEmailAccount,
  saveEmailAccount,
} from "../email/email-account-store.js";
import { openaiError } from "./openai-errors.js";
import { onClientGone, readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/** Account setup stays at authenticated ingress; sending stays in approval-gated tools. */
export function createEmailHandlers(): Record<"get" | "put" | "remove" | "check", HttpHandler> {
  return {
    get(_req, res) {
      try {
        sendJson(res, 200, emailAccountStatus(), { "cache-control": "no-store" });
      } catch {
        sendError(res, 500, openaiError("Could not read the email settings.", "server_error"));
      }
    },
    async put(req, res, ctx) {
      let input: unknown;
      try { input = await readJsonBody(req); }
      catch {
        // JSON parser errors can contain a fragment of the password-bearing body.
        sendError(res, 400, openaiError("Invalid email settings JSON."));
        return;
      }
      if (ctx.runtime.turnController.busySessionIds().length) {
        sendError(res, 409, openaiError("Wait for the running reply to finish before changing the email account.", "invalid_request_error", null, "turn_in_progress"));
        return;
      }
      try {
        saveEmailAccount(input);
        sendJson(res, 200, { saved: true, restartRequired: true }, { "cache-control": "no-store" });
      } catch (err) {
        const invalid = err instanceof EmailAccountInputError;
        sendError(res, invalid ? 400 : 500, openaiError(invalid ? err.message : "Could not save the email settings.", invalid ? "invalid_request_error" : "server_error"));
      }
    },
    remove(_req, res, ctx) {
      if (ctx.runtime.turnController.busySessionIds().length) {
        sendError(res, 409, openaiError("Wait for the running reply to finish before removing the email account.", "invalid_request_error", null, "turn_in_progress"));
        return;
      }
      try {
        removeEmailAccount();
        sendJson(res, 200, { removed: true, restartRequired: true }, { "cache-control": "no-store" });
      } catch {
        sendError(res, 500, openaiError("Could not remove the email account.", "server_error"));
      }
    },
    async check(_req, res) {
      const abort = new AbortController();
      onClientGone(res, () => abort.abort());
      try {
        await new EmailService().check({ signal: abort.signal });
        if (!res.destroyed) sendJson(res, 200, { verified: true }, { "cache-control": "no-store" });
      } catch (err) {
        if (!res.destroyed) sendError(res, 502, openaiError(
          err instanceof EmailServiceError ? err.message : "Could not connect to the email servers. Check the server settings and passwords.",
          "server_error", null, "email_connection_failed",
        ));
      }
    },
  };
}
