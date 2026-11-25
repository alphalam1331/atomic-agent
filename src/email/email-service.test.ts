import type { FetchMessageObject, FetchQueryObject } from "imapflow";
import { describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../config/index.js";
import { EmailService, EmailServiceError, EMAIL_IMAP_PASSWORD_ENV, EMAIL_SMTP_PASSWORD_ENV, readEmailPassword } from "./email-service.js";
import type { EmailImapClient, EmailSmtpClient } from "./email-transports.js";

function account(): Pick<AtomicAgentConfig, "email"> {
  return { email: {
    enabled: true, address: "agent@example.com",
    imap: { host: "imap.example.com", port: 993, security: "tls", username: "inbox-user" },
    smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "sender-user" },
  } };
}

function fixture() {
  const config = account();
  const env = {
    [EMAIL_IMAP_PASSWORD_ENV]: Buffer.from("inbox ' # \\ 密碼\n").toString("base64"),
    [EMAIL_SMTP_PASSWORD_ENV]: Buffer.from("smtp-secret").toString("base64"),
  };
  const release = vi.fn();
  const imap = {
    mailbox: { exists: 1000 }, connect: vi.fn(async () => {}),
    getMailboxLock: vi.fn(async () => ({ release })),
    fetchAll: vi.fn(async (_range: string, _query: FetchQueryObject): Promise<FetchMessageObject[]> => []),
    fetchOne: vi.fn(async (): Promise<FetchMessageObject | false> => false),
    close: vi.fn(), on: vi.fn(),
  } satisfies EmailImapClient;
  const smtp = {
    verify: vi.fn(async () => true), sendMail: vi.fn(async () => ({ messageId: "sent-id" })), close: vi.fn(),
  } satisfies EmailSmtpClient;
  const createImapClient = vi.fn(() => imap);
  const createSmtpTransport = vi.fn(() => smtp);
  const service = new EmailService({ config: () => config, env, createImapClient, createSmtpTransport });
  return { config, env, imap, smtp, release, createImapClient, createSmtpTransport, service };
}

describe("configured EmailService", () => {
  it("decodes UTF-8 passwords losslessly and refuses absent or malformed credentials", () => {
    const f = fixture();
    expect(readEmailPassword(EMAIL_IMAP_PASSWORD_ENV, f.env)).toBe("inbox ' # \\ 密碼\n");
    expect(f.service.readiness()).toEqual({ level: "ready", address: "agent@example.com" });
    f.env[EMAIL_IMAP_PASSWORD_ENV] = "not-base64!";
    expect(f.service.readiness()).toEqual({ level: "no_inbox" });
    expect(readEmailPassword("password", { password: "/w==" })).toBeNull();
    f.config.email.enabled = false;
    expect(f.service.readiness()).toEqual({ level: "no_inbox" });
  });

  it("checks both servers with independent credentials, strict TLS and no message delivery", async () => {
    const f = fixture();
    await f.service.check();
    expect(f.createImapClient).toHaveBeenCalledWith(expect.objectContaining({
      host: "imap.example.com", port: 993, secure: true, doSTARTTLS: false,
      auth: { user: "inbox-user", pass: "inbox ' # \\ 密碼\n" },
      logger: false, logRaw: false, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    }));
    expect(f.createSmtpTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.com", port: 587, secure: false, requireTLS: true,
      auth: { user: "sender-user", pass: "smtp-secret" }, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(f.smtp.verify).toHaveBeenCalledOnce();
    expect(f.smtp.sendMail).not.toHaveBeenCalled();
    expect(f.imap.close).toHaveBeenCalled();
    expect(f.smtp.close).toHaveBeenCalled();
  });

  it("lists a bounded newest-first slice read-only and decodes a bounded plain-text preview", async () => {
    const f = fixture();
    f.imap.fetchAll.mockResolvedValue([
      { uid: 6, seq: 999, flags: new Set(["\\Seen"]), envelope: { from: [{ address: "old@example.com" }], subject: "older" } },
      { uid: 7, seq: 1000, flags: new Set(), internalDate: new Date("2026-11-24T00:00:00Z"),
        envelope: { from: [{ name: "Sender", address: "new@example.com" }], subject: "newest" },
        bodyStructure: { type: "multipart/mixed", childNodes: [
          { part: "1", type: "text/plain", encoding: "base64", parameters: { charset: "utf-8" } },
          { part: "2", type: "text/plain", disposition: "attachment" },
        ] },
      },
    ]);
    f.imap.fetchOne.mockResolvedValue({ uid: 7, seq: 1000, bodyParts: new Map([["1", Buffer.from(Buffer.from("Hello\r\n你好").toString("base64"))]]) });
    const messages = await f.service.listInbox(2);
    expect(f.imap.getMailboxLock).toHaveBeenCalledWith("INBOX", { readOnly: true });
    expect(f.imap.fetchAll).toHaveBeenCalledWith("999:1000", expect.objectContaining({ envelope: true, bodyStructure: true }));
    expect(f.imap.fetchOne).toHaveBeenCalledWith("7", { bodyParts: [{ key: "1", start: 0, maxLength: 1024 }] }, { uid: true });
    expect(messages).toEqual([
      { id: "7", from: "Sender <new@example.com>", subject: "newest", receivedAt: "2026-11-24T00:00:00.000Z", preview: "Hello 你好", unread: true },
      { id: "6", from: "old@example.com", subject: "older", receivedAt: "", preview: "", unread: false },
    ]);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.imap.close).toHaveBeenCalled();
  });

  it("uses one settings and credential snapshot throughout a connection check", async () => {
    const f = fixture();
    let connected: () => void = () => {};
    f.imap.connect.mockImplementation(() => new Promise<void>((resolve) => { connected = resolve; }));
    const checking = f.service.check();
    f.config.email.smtp.host = "replacement.example.com";
    f.config.email.smtp.username = "replacement-user";
    f.env[EMAIL_SMTP_PASSWORD_ENV] = Buffer.from("replacement-secret").toString("base64");
    connected();
    await checking;
    expect(f.createSmtpTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com", auth: { user: "sender-user", pass: "smtp-secret" } }));
  });

  it("does not fetch an empty inbox and caps requested message counts", async () => {
    const f = fixture();
    await f.service.listInbox(1000);
    expect(f.imap.fetchAll.mock.calls[0]?.[0]).toBe("901:1000");
    f.imap.mailbox.exists = 0;
    f.imap.fetchAll.mockClear();
    expect(await f.service.listInbox()).toEqual([]);
    expect(f.imap.fetchAll).not.toHaveBeenCalled();
  });

  it("sends from the configured account with the operation signal and closes the transport", async () => {
    const f = fixture();
    expect(await f.service.send({ to: "user@example.com", subject: "Hello", text: "Body" })).toBe("sent-id");
    expect(f.smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: "agent@example.com", to: "user@example.com", subject: "Hello", text: "Body", signal: expect.any(AbortSignal),
    }));
    expect(f.imap.connect).not.toHaveBeenCalled();
    expect(f.smtp.close).toHaveBeenCalled();
  });

  it("redacts authentication failures, releases an inbox lock on failure, and skips SMTP after IMAP fails", async () => {
    const f = fixture();
    f.imap.fetchAll.mockRejectedValue(new Error("AUTH inbox-secret smtp-secret"));
    await expect(f.service.listInbox()).rejects.toThrow("IMAP connection failed. Check the server");
    expect(f.release).toHaveBeenCalledOnce();
    f.imap.connect.mockRejectedValue(new Error("password leaked"));
    await expect(f.service.check()).rejects.toBeInstanceOf(EmailServiceError);
    expect(f.createSmtpTransport).not.toHaveBeenCalled();
    f.smtp.sendMail.mockRejectedValue(new Error("AUTH smtp-secret"));
    await expect(f.service.send({ to: "user@example.com", subject: "Hello", text: "Body" })).rejects.toThrow("SMTP connection failed.");
  });

  it("cancels stalled IMAP and SMTP work, closes clients, and never starts a pre-aborted operation", async () => {
    const f = fixture();
    f.imap.connect.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = f.service.check({ signal: controller.signal });
    controller.abort(new Error("private cancellation reason"));
    await expect(pending).rejects.toThrow("Email operation cancelled.");
    expect(f.imap.close).toHaveBeenCalled();
    expect(f.createSmtpTransport).not.toHaveBeenCalled();
    f.smtp.sendMail.mockImplementation(() => new Promise(() => {}));
    const sendAbort = new AbortController();
    const sending = f.service.send({ to: "user@example.com", subject: "Hello", text: "Body" }, { signal: sendAbort.signal });
    sendAbort.abort();
    await expect(sending).rejects.toThrow("cancelled");
    expect(f.smtp.close).toHaveBeenCalled();
    f.smtp.sendMail.mockClear();
    await expect(f.service.send({ to: "user@example.com", subject: "Hello", text: "Body" }, { signal: sendAbort.signal })).rejects.toThrow("cancelled");
    expect(f.smtp.sendMail).not.toHaveBeenCalled();
  });

  it("bounds a stalled operation's overall duration", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.imap.connect.mockImplementation(() => new Promise(() => {}));
      const service = new EmailService({ config: () => f.config, env: f.env, createImapClient: f.createImapClient, operationTimeoutMs: 50 });
      const result = expect(service.check()).rejects.toThrow("IMAP connection timed out.");
      await vi.advanceTimersByTimeAsync(50);
      await result;
      expect(f.imap.close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
