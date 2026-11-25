import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  setDotenvKey,
  writeUserConfigFileSync,
  type EmailConfig,
} from "../config/index.js";
import { writeOwnerOnlyFileAtomicSync } from "../config/owner-only-file.js";
import {
  EMAIL_IMAP_PASSWORD_ENV,
  EMAIL_SMTP_PASSWORD_ENV,
  readEmailPassword,
} from "./email-service.js";

export class EmailAccountInputError extends Error {}

/** Public account facts only. Passwords never leave this module through a result. */
export function emailAccountStatus() {
  const config = ensureUserConfigFileSync(getConfig().paths.userConfigFile).email;
  return {
    config,
    hasImapPassword: readEmailPassword(EMAIL_IMAP_PASSWORD_ENV) !== null,
    hasSmtpPassword: readEmailPassword(EMAIL_SMTP_PASSWORD_ENV) !== null,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new EmailAccountInputError("Unknown email setting. Use the account and server fields shown in Connections.");
  }
}

function password(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new EmailAccountInputError("Passwords must be one line and at most 4096 bytes.");
  }
  return value;
}

/** Validate everything before writing either credentials or account settings. */
export function saveEmailAccount(input: unknown): void {
  if (!object(input) || !object(input.config)) {
    throw new EmailAccountInputError("Expected email account settings.");
  }
  keys(input, ["config", "imapPassword", "smtpPassword"]);
  keys(input.config, ["enabled", "address", "imap", "smtp"]);
  for (const server of [input.config.imap, input.config.smtp]) {
    if (object(server)) keys(server, ["host", "port", "security", "username"]);
  }
  const paths = getConfig().paths;
  const previous = ensureUserConfigFileSync(paths.userConfigFile);
  let next;
  try {
    next = parseUserConfigFile({ ...previous, email: input.config });
  } catch (err) {
    if (err instanceof ConfigValidationError && err.field.startsWith("email")) {
      // Shared scalar validators include the rejected value in their text.
      // A misplaced password must never be echoed back as that value.
      throw new EmailAccountInputError(`Invalid email setting: ${err.field}. Check the value and try again.`);
    }
    throw err;
  }
  const imap = password(input.imapPassword);
  const smtp = password(input.smtpPassword);
  if (next.email.enabled && (
    !(imap ?? readEmailPassword(EMAIL_IMAP_PASSWORD_ENV)) ||
    !(smtp ?? readEmailPassword(EMAIL_SMTP_PASSWORD_ENV))
  )) {
    throw new EmailAccountInputError("Enter both IMAP and SMTP passwords or app passwords before enabling email.");
  }
  persist(next.email, [[EMAIL_IMAP_PASSWORD_ENV, imap], [EMAIL_SMTP_PASSWORD_ENV, smtp]]);
}

export function removeEmailAccount(): void {
  // Parsing the absent block supplies the same defaults as a new installation.
  const empty = parseUserConfigFile({}).email;
  persist(empty, [[EMAIL_IMAP_PASSWORD_ENV, null], [EMAIL_SMTP_PASSWORD_ENV, null]]);
}

function persist(config: EmailConfig, credentials: [string, string | null | undefined][]) {
  const paths = getConfig().paths;
  const previous = ensureUserConfigFileSync(paths.userConfigFile);
  const next = parseUserConfigFile({ ...previous, email: config });
  const dotenvPath = join(paths.stateDir, ".env");
  const hadDotenv = existsSync(dotenvPath);
  const previousDotenv = hadDotenv ? readFileSync(dotenvPath, "utf8") : null;
  try {
    for (const [name, value] of credentials) {
      if (value !== undefined) {
        // Base64 preserves quotes, spaces and backslashes through the small dotenv loader.
        setDotenvKey(paths.stateDir, name, value === null ? null : Buffer.from(value, "utf8").toString("base64"));
      }
    }
    writeUserConfigFileSync(paths.userConfigFile, next);
  } catch (error) {
    if (previousDotenv !== null) writeOwnerOnlyFileAtomicSync(dotenvPath, previousDotenv);
    else rmSync(dotenvPath, { force: true });
    throw error;
  }
  for (const [name, value] of credentials) {
    if (value === null) delete process.env[name];
    else if (value !== undefined) process.env[name] = Buffer.from(value, "utf8").toString("base64");
  }
  resetConfigCache();
}
