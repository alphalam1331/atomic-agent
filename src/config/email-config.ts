import { isIP } from "node:net";

import { parseBool, parseBoundedPositiveInt } from "./config-primitives.js";
import { parseNullableString } from "./config-values.js";
import { ConfigValidationError } from "./config-validation-error.js";

export type EmailSecurity = "tls" | "starttls";

export interface EmailServerConfig {
  host: string | null;
  port: number;
  security: EmailSecurity;
  username: string | null;
}

/** Operator-owned mailbox. Passwords live in the state-directory .env. */
export interface EmailConfig {
  enabled: boolean;
  address: string | null;
  imap: EmailServerConfig;
  smtp: EmailServerConfig;
}

export function createEmailDefaults(): EmailConfig {
  return {
    enabled: false,
    address: null,
    imap: { host: null, port: 993, security: "tls", username: null },
    smtp: { host: null, port: 465, security: "tls", username: null },
  };
}

function objectOrEmpty(raw: unknown, field: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected an object");
  }
  return raw as Record<string, unknown>;
}

function nullableSingleLine(raw: unknown, field: string): string | null {
  if (typeof raw === "string" && /[\p{Cc}\u2028\u2029]/u.test(raw)) {
    throw new ConfigValidationError(field, "must not contain control characters");
  }
  return parseNullableString(raw, field);
}

function isHostname(host: string): boolean {
  if (host.length > 253 || /^[\d.]+$/.test(host)) return false;
  const labels = host.endsWith(".") ? host.slice(0, -1).split(".") : host.split(".");
  return labels.every((label) =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
  );
}

function parseHost(raw: unknown, field: string): string | null {
  const host = nullableSingleLine(raw, field);
  if (host === null || isIP(host) !== 0 || isHostname(host)) return host;
  throw new ConfigValidationError(field, "expected a hostname or IP address without a URL or port");
}

function parseAddress(raw: unknown): string | null {
  const field = "email.address";
  const address = nullableSingleLine(raw, field);
  if (address === null) return null;
  const parts = address.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (
    address.length > 254 || parts.length !== 2 || local.length === 0 ||
    local.length > 64 || local.startsWith(".") || local.endsWith(".") ||
    local.includes("..") || !/^[a-z\d!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) ||
    !isHostname(domain)
  ) {
    throw new ConfigValidationError(field, "expected one email address without a display name");
  }
  return address;
}

function parseSecurity(raw: unknown, field: string): EmailSecurity {
  if (raw === "tls" || raw === "starttls") return raw;
  throw new ConfigValidationError(field, 'expected "tls" or "starttls"');
}

function parseServer(
  raw: unknown,
  field: string,
  defaults: EmailServerConfig,
): EmailServerConfig {
  const obj = objectOrEmpty(raw, field);
  return {
    host: parseHost(obj.host, `${field}.host`),
    port: parseBoundedPositiveInt(obj.port ?? defaults.port, `${field}.port`, 1, 65_535),
    security: parseSecurity(obj.security ?? defaults.security, `${field}.security`),
    username: nullableSingleLine(obj.username, `${field}.username`),
  };
}

/** Configuration parsing never authenticates, opens connections or reads secrets. */
export function parseEmailConfig(
  raw: unknown,
  defaults: EmailConfig = createEmailDefaults(),
): EmailConfig {
  const obj = objectOrEmpty(raw, "email");
  const result: EmailConfig = {
    enabled: parseBool(obj.enabled ?? defaults.enabled, "email.enabled"),
    address: parseAddress(obj.address),
    imap: parseServer(obj.imap, "email.imap", defaults.imap),
    smtp: parseServer(obj.smtp, "email.smtp", defaults.smtp),
  };
  if (result.enabled) {
    for (const [field, value] of [
      ["email.address", result.address],
      ["email.imap.host", result.imap.host],
      ["email.imap.username", result.imap.username],
      ["email.smtp.host", result.smtp.host],
      ["email.smtp.username", result.smtp.username],
    ] as const) {
      if (value === null) {
        throw new ConfigValidationError(field, "required when email is enabled");
      }
    }
  }
  return result;
}
