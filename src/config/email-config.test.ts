import { describe, expect, it } from "vitest";

import { createEmailDefaults, parseEmailConfig } from "./email-config.js";
import { ConfigValidationError, parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";

const account = {
  enabled: true,
  address: "agent+tasks@example.com",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "agent@example.com" },
  smtp: { host: "smtp.example.com", port: 587, security: "starttls", username: "smtp-user" },
};

describe("email configuration", () => {
  it("keeps files without email settings compatible and disabled without a migration", () => {
    for (const version of [42, USER_CONFIG_VERSION]) {
      const parsed = parseUserConfigFile({ version });
      expect(parsed.email).toEqual(createEmailDefaults());
      expect(parsed.version).toBe(USER_CONFIG_VERSION);
    }
    expect(parseEmailConfig(null)).toEqual(createEmailDefaults());
  });

  it("normalizes independently configurable IMAP/SMTP servers and scalar strings", () => {
    const parsed = parseUserConfigFile({
      email: {
        ...account,
        enabled: "true",
        address: " agent+tasks@example.com ",
        imap: { ...account.imap, host: " imap.example.com ", port: "993" },
      },
    });
    expect(parsed.email).toEqual(account);
  });

  it("permits incomplete saved configuration while disabled", () => {
    expect(parseEmailConfig({ address: "agent@example.com", imap: { host: "localhost" } }))
      .toEqual({
        ...createEmailDefaults(),
        address: "agent@example.com",
        imap: { ...createEmailDefaults().imap, host: "localhost" },
      });
  });

  it.each([
    ["address", { ...account, address: null }],
    ["imap.host", { ...account, imap: { ...account.imap, host: null } }],
    ["imap.username", { ...account, imap: { ...account.imap, username: "" } }],
    ["smtp.host", { ...account, smtp: { ...account.smtp, host: null } }],
    ["smtp.username", { ...account, smtp: { ...account.smtp, username: null } }],
  ])("requires %s before enabling", (field, raw) => {
    expect(() => parseEmailConfig(raw)).toThrow(`email.${field}: required when email is enabled`);
  });

  it.each(["https://mail.example.com", "mail.example.com:993", "mail.example.com/path", "mail.example.com\n", "-bad.example", "999.1.1.1"])(
    "rejects an invalid server host %j even when disabled", (host) => {
      expect(() => parseEmailConfig({ imap: { host } })).toThrow(ConfigValidationError);
    },
  );

  it.each(["localhost", "127.0.0.1", "2001:db8::1", "mail.example.com"])(
    "accepts server hostname or IP %s", (host) => {
      expect(parseEmailConfig({ imap: { host } }).imap.host).toBe(host);
    },
  );

  it.each([0, 65_536, 2.5, "993junk"])("rejects invalid port %j", (port) => {
    expect(() => parseEmailConfig({ smtp: { port } })).toThrow(ConfigValidationError);
  });

  it.each([1, 65_535])("accepts boundary port %s", (port) => {
    expect(parseEmailConfig({ smtp: { port } }).smtp.port).toBe(port);
  });

  it.each(["plain", "none", "ssl", true])("rejects unsupported security %j", (security) => {
    expect(() => parseEmailConfig({ smtp: { security } })).toThrow(ConfigValidationError);
  });

  it.each(["agent@example.com,other@example.com", "Agent <agent@example.com>", "agent@example.com\r\nBcc: secret@example.com", "agent", ".agent@example.com"])(
    "rejects malformed or multiple addresses %j", (address) => {
      expect(() => parseEmailConfig({ address })).toThrow(ConfigValidationError);
    },
  );

  it("rejects username controls and malformed blocks", () => {
    expect(() => parseEmailConfig({ imap: { username: "agent\u0000" } })).toThrow(ConfigValidationError);
    for (const raw of [false, "mail", [], { imap: "mail" }, { smtp: [] }]) {
      expect(() => parseEmailConfig(raw)).toThrow(ConfigValidationError);
    }
  });

  it("does not carry passwords into parsed config", () => {
    const parsed = parseEmailConfig({
      ...account,
      password: "do-not-store",
      imap: { ...account.imap, password: "do-not-store" },
      smtp: { ...account.smtp, password: "do-not-store" },
    });
    expect(parsed).toEqual(account);
    expect(JSON.stringify(parsed)).not.toContain("do-not-store");
  });
});
