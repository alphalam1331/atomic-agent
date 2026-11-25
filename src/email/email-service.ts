import type { ImapFlowOptions } from "imapflow";
import { getConfig, type AtomicAgentConfig } from "../config/index.js";
import type { InboxMessage } from "../atomic-mail/index.js";
import { EMAIL_PREVIEW_BYTES, messagePreview, previewPart } from "./email-preview.js";
import {
  createEmailImapClient, createEmailSmtpClient,
  type CreateEmailImapClient, type CreateEmailSmtpClient,
  type EmailImapClient, type EmailSmtpClient, type EmailSmtpOptions,
} from "./email-transports.js";

export const EMAIL_IMAP_PASSWORD_ENV = "EMAIL_IMAP_PASSWORD_B64";
export const EMAIL_SMTP_PASSWORD_ENV = "EMAIL_SMTP_PASSWORD_B64";
const CONNECTION_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 45_000;
const ADDRESS = /^[a-z\d!#$%&'*+/=?^_`{|}~.-]+@[a-z\d.-]+$/i;

interface EmailSnapshot {
  config: AtomicAgentConfig["email"];
  address: string;
  imapPassword: string;
  smtpPassword: string;
}

/** Passwords are base64 on disk so dotenv quoting cannot change them. */
export function readEmailPassword(key: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const encoded = env[key];
  if (!encoded || encoded.length > 32_768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  const password = bytes.toString("utf8");
  return password.length && Buffer.from(password, "utf8").equals(bytes) ? password : null;
}

export class EmailServiceError extends Error {
  constructor(readonly stage: "IMAP" | "SMTP" | "configuration", message?: string) {
    super(message ?? `${stage} connection failed. Check the server, port, security, username and app password in Settings → Connections → Email.`);
    this.name = "EmailServiceError";
  }
}

export interface EmailServiceOptions {
  config?: () => Pick<AtomicAgentConfig, "email">;
  env?: NodeJS.ProcessEnv;
  createImapClient?: CreateEmailImapClient;
  createSmtpTransport?: CreateEmailSmtpClient;
  /** Test seam for a stalled transport. */
  operationTimeoutMs?: number;
}

export type EmailReadiness = { level: "ready"; address: string } | { level: "no_inbox" };

export class EmailService {
  private readonly config: NonNullable<EmailServiceOptions["config"]>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly imapFactory: CreateEmailImapClient;
  private readonly smtpFactory: CreateEmailSmtpClient;
  private readonly timeoutMs: number;

  constructor(options: EmailServiceOptions = {}) {
    this.config = options.config ?? getConfig;
    this.env = options.env ?? process.env;
    this.imapFactory = options.createImapClient ?? createEmailImapClient;
    this.smtpFactory = options.createSmtpTransport ?? createEmailSmtpClient;
    this.timeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  }

  readiness(): EmailReadiness {
    const snapshot = this.snapshot();
    return snapshot ? { level: "ready", address: snapshot.address } : { level: "no_inbox" };
  }

  private snapshot(): EmailSnapshot | null {
    const config = this.config().email;
    const imapPassword = readEmailPassword(EMAIL_IMAP_PASSWORD_ENV, this.env);
    const smtpPassword = readEmailPassword(EMAIL_SMTP_PASSWORD_ENV, this.env);
    if (!config?.enabled || !config.address || !ADDRESS.test(config.address) ||
        !config.imap.host || !config.imap.username || !config.smtp.host || !config.smtp.username ||
        !imapPassword || !smtpPassword) return null;
    return { config: { ...config, imap: { ...config.imap }, smtp: { ...config.smtp } }, address: config.address, imapPassword, smtpPassword };
  }

  private requireReady(): EmailSnapshot {
    const snapshot = this.snapshot();
    if (!snapshot) throw new EmailServiceError("configuration", "Configure the email account and both app passwords in Settings → Connections → Email.");
    return snapshot;
  }

  private imapOptions(snapshot: EmailSnapshot): ImapFlowOptions {
    const endpoint = snapshot.config.imap;
    return {
      host: endpoint.host!, port: endpoint.port, secure: endpoint.security === "tls",
      doSTARTTLS: endpoint.security === "starttls", auth: { user: endpoint.username!, pass: snapshot.imapPassword },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      logger: false, emitLogs: false, logRaw: false,
      disableAutoIdle: true, disableCompression: true,
      connectionTimeout: CONNECTION_TIMEOUT_MS, greetingTimeout: CONNECTION_TIMEOUT_MS, socketTimeout: CONNECTION_TIMEOUT_MS,
      maxLineLength: 64 * 1024, maxLiteralSize: 64 * 1024, maxResponseSize: 128 * 1024, maxResponseTokens: 20_000,
    };
  }

  private smtpOptions(snapshot: EmailSnapshot): EmailSmtpOptions {
    const endpoint = snapshot.config.smtp;
    return {
      host: endpoint.host!, port: endpoint.port, secure: endpoint.security === "tls", requireTLS: endpoint.security === "starttls",
      auth: { user: endpoint.username!, pass: snapshot.smtpPassword },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: CONNECTION_TIMEOUT_MS, greetingTimeout: CONNECTION_TIMEOUT_MS, socketTimeout: CONNECTION_TIMEOUT_MS,
    };
  }

  /** Close even a stalled connection and reject promptly on cancellation. */
  private async operation<T>(stage: "IMAP" | "SMTP", client: EmailImapClient | EmailSmtpClient, fn: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    timer.unref();
    const signal = caller ? AbortSignal.any([caller, timeout.signal]) : timeout.signal;
    const close = () => { try { client.close(); } catch { /* Cleanup never exposes a transport exception. */ } };
    let onAbort: () => void = () => {};
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(new EmailServiceError(stage, caller?.aborted ? "Email operation cancelled." : `${stage} connection timed out. Check the server and port in Settings → Connections → Email.`));
        close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      if (signal.aborted) onAbort();
      else return await Promise.race([fn(signal), abort]);
      return await abort;
    } catch (error) {
      if (error instanceof EmailServiceError) throw error;
      // SMTP/IMAP exceptions can contain AUTH commands or server echoes.
      throw new EmailServiceError(stage);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      close();
    }
  }

  private imap(snapshot: EmailSnapshot): EmailImapClient {
    try {
      const client = this.imapFactory(this.imapOptions(snapshot));
      client.on("error", () => {}); // An asynchronous socket failure must not crash the runtime or print secrets.
      return client;
    } catch { throw new EmailServiceError("IMAP"); }
  }

  private smtp(snapshot: EmailSnapshot): EmailSmtpClient {
    try { return this.smtpFactory(this.smtpOptions(snapshot)); }
    catch { throw new EmailServiceError("SMTP"); }
  }

  async check(options: { signal?: AbortSignal } = {}): Promise<void> {
    const snapshot = this.requireReady();
    const imap = this.imap(snapshot);
    await this.operation("IMAP", imap, () => imap.connect(), options.signal);
    const smtp = this.smtp(snapshot);
    await this.operation("SMTP", smtp, () => smtp.verify(), options.signal);
  }

  async listInbox(limit = 20, options: { signal?: AbortSignal } = {}): Promise<InboxMessage[]> {
    const snapshot = this.requireReady();
    const client = this.imap(snapshot);
    return this.operation("IMAP", client, async () => {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const count = client.mailbox ? client.mailbox.exists : 0;
        if (!count) return [];
        const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
        const messages = await client.fetchAll(`${Math.max(1, count - boundedLimit + 1)}:${count}`, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true });
        const inbox: InboxMessage[] = [];
        for (const message of messages.slice(-boundedLimit).sort((a, b) => b.seq - a.seq)) {
          const from = message.envelope?.from?.[0];
          const part = previewPart(message.bodyStructure);
          const preview = part ? messagePreview(await client.fetchOne(String(message.uid), { bodyParts: [{ key: part.part || "TEXT", start: 0, maxLength: EMAIL_PREVIEW_BYTES }] }, { uid: true }), part) : "";
          const received = message.internalDate ?? message.envelope?.date;
          inbox.push({ id: String(message.uid), from: from?.name ? `${from.name} <${from.address ?? ""}>` : from?.address ?? "", subject: (message.envelope?.subject ?? "").slice(0, 1000),
            receivedAt: received instanceof Date ? received.toISOString() : received ?? "", preview, unread: !message.flags?.has("\\Seen") });
        }
        return inbox;
      } finally { lock.release(); }
    }, options.signal);
  }

  async send(mail: { to: string; subject: string; text: string; html?: string }, options: { signal?: AbortSignal } = {}): Promise<string> {
    const snapshot = this.requireReady();
    if (!ADDRESS.test(mail.to) || !mail.subject.trim() || /[\r\n]/.test(mail.subject) || !mail.text.trim()) throw new EmailServiceError("configuration", "Email needs one recipient, a single-line subject and a text body.");
    const smtp = this.smtp(snapshot);
    return this.operation("SMTP", smtp, async (signal) => {
      const result = await smtp.sendMail({ from: snapshot.address, to: mail.to, subject: mail.subject, text: mail.text, ...(mail.html === undefined ? {} : { html: mail.html }), signal });
      return result.messageId;
    }, options.signal);
  }
}
