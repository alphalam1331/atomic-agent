import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailService } from "../email/email-service.js";
import { loadDotenvFromStateDir, resetConfigCache, type EmailConfig } from "../config/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const account = {
  enabled: true,
  address: "agent@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "agent@example.com" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "smtp-user" },
};
const IMAP = "EMAIL_IMAP_PASSWORD_B64";
const SMTP = "EMAIL_SMTP_PASSWORD_B64";

describe("email account settings routes", () => {
  let harness: Harness;
  let previousImap: string | undefined;
  let previousSmtp: string | undefined;
  beforeEach(async () => {
    previousImap = process.env[IMAP];
    previousSmtp = process.env[SMTP];
    delete process.env[IMAP];
    delete process.env[SMTP];
    harness = await startTestHarness({ apiKey: "email-settings-test" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
    if (previousImap === undefined) delete process.env[IMAP];
    else process.env[IMAP] = previousImap;
    if (previousSmtp === undefined) delete process.env[SMTP];
    else process.env[SMTP] = previousSmtp;
    resetConfigCache();
  });

  const request = (method = "GET", body?: unknown, suffix = "", auth = true) => fetch(`${harness.baseUrl}/api/email${suffix}`, {
    method,
    headers: { ...(auth ? { authorization: "Bearer email-settings-test" } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const save = (over: Record<string, unknown> = {}) => request("PUT", {
    config: account, imapPassword: 'imap-Pass12"\\with spaces', smtpPassword: "smtp-Pass34'!", ...over,
  });
  const status = async () => (await (await request()).json()) as {
    config: EmailConfig; hasImapPassword: boolean; hasSmtpPassword: boolean;
  };

  it("authenticates every account route before reading, writing or checking", async () => {
    const check = vi.spyOn(EmailService.prototype, "check").mockResolvedValue();
    for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["DELETE", ""], ["POST", "/check"]]) {
      expect((await request(method, undefined, suffix, false)).status).toBe(401);
    }
    expect(check).not.toHaveBeenCalled();
    expect((await status()).hasImapPassword).toBe(false);
  });

  it("saves provider settings and owner-only credentials that round-trip through dotenv, never returning passwords", async () => {
    const response = await save();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, restartRequired: true });
    const status = await request();
    expect(status.headers.get("cache-control")).toBe("no-store");
    const facts = await status.json();
    expect(facts).toEqual({ config: account, hasImapPassword: true, hasSmtpPassword: true });
    const configText = readFileSync(join(harness.stateDir, "config.json"), "utf8");
    expect(configText).not.toContain("Password");
    delete process.env[IMAP];
    delete process.env[SMTP];
    loadDotenvFromStateDir(harness.stateDir);
    expect(Buffer.from(process.env[IMAP]!, "base64").toString("utf8")).toBe('imap-Pass12"\\with spaces');
    expect(Buffer.from(process.env[SMTP]!, "base64").toString("utf8")).toBe("smtp-Pass34'!");
    if (process.platform !== "win32") {
      expect(statSync(join(harness.stateDir, ".env")).mode & 0o777).toBe(0o600);
      expect(statSync(join(harness.stateDir, "config.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps saved credentials for omitted or empty password fields", async () => {
    expect((await save()).status).toBe(200);
    const imap = process.env[IMAP];
    const smtp = process.env[SMTP];
    expect((await request("PUT", { config: { ...account, smtp: { ...account.smtp, port: 465, security: "tls" } }, imapPassword: "" })).status).toBe(200);
    expect(process.env[IMAP]).toBe(imap);
    expect(process.env[SMTP]).toBe(smtp);
  });

  it("validates before changing the existing account or credentials", async () => {
    expect((await save()).status).toBe(200);
    const before = readFileSync(join(harness.stateDir, ".env"), "utf8");
    for (const patch of [
      { config: { ...account, smtp: { ...account.smtp, host: "https://smtp.example.com" } } },
      { config: { ...account, imap: { ...account.imap, port: 70000 } } },
      { config: { ...account, password: "must-not-go-in-config" } },
      { imapPassword: "secret\nBAD=1" },
      { smtpPassword: 42 },
    ]) {
      expect((await save(patch)).status).toBe(400);
      expect(readFileSync(join(harness.stateDir, ".env"), "utf8")).toBe(before);
    }
    expect((await status()).config).toEqual(account);
  });

  it("requires both passwords before enabling a new account", async () => {
    const response = await request("PUT", { config: account, imapPassword: "one-side-only" });
    expect(response.status).toBe(400);
    expect((await status()).hasImapPassword).toBe(false);
  });

  it("checks saved logins without sending and suppresses raw transport errors", async () => {
    expect((await save()).status).toBe(200);
    const check = vi.spyOn(EmailService.prototype, "check").mockResolvedValue();
    const send = vi.spyOn(EmailService.prototype, "send");
    expect(await (await request("POST", undefined, "/check")).json()).toEqual({ verified: true });
    expect(check).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(send).not.toHaveBeenCalled();
    check.mockRejectedValue(new Error("AUTH smtp-Pass34-secret"));
    const failed = await request("POST", undefined, "/check");
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("smtp-Pass34-secret");
  });

  it("removes only the configured email account and its credentials", async () => {
    expect((await save()).status).toBe(200);
    expect((await request("DELETE")).status).toBe(200);
    const facts = await (await request()).json();
    expect(facts).toMatchObject({ config: { enabled: false, address: null }, hasImapPassword: false, hasSmtpPassword: false });
    expect(process.env[IMAP]).toBeUndefined();
    expect(process.env[SMTP]).toBeUndefined();
  });

  it("refuses account changes while a turn is running", async () => {
    vi.spyOn(harness.runtime.turnController, "busySessionIds").mockReturnValue(["busy-session"]);
    expect((await save()).status).toBe(409);
    expect((await request("DELETE")).status).toBe(409);
    expect((await status()).config.enabled).toBe(false);
  });

  it("does not echo password-bearing malformed JSON", async () => {
    const res = await fetch(`${harness.baseUrl}/api/email`, {
      method: "PUT", headers: { authorization: "Bearer email-settings-test" }, body: '{"imapPassword": secret-that-must-stay-private',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("secret-that-must-stay-private");
  });

  it("does not echo credentials accidentally pasted into another setting", async () => {
    for (const config of [
      { ...account, enabled: { password: "private-password-value" } },
      { ...account, imap: { ...account.imap, port: "private-password-value" } },
    ]) {
      const res = await save({ config });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain("private-password-value");
    }
  });
});
