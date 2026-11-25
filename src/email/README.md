# Email account

Status: current
Owner: src/email/

[EmailService](email-service.ts) connects an operator-configured account through IMAP and SMTP. The Connections tab stores server settings in `config.email` and passwords in the state directory's owner-only `.env`, base64 encoded to preserve arbitrary UTF-8 characters. Base64 is an encoding, not encryption. Passwords are decoded only for authentication and never returned in status or errors.

Both implicit TLS and mandatory STARTTLS validate certificates. Each operation owns fresh clients, finite connection and overall timeouts, and cancellation closes the clients. Inbox listings open INBOX read-only, request at most 100 messages and 1024 bytes per plain-text preview, and never mark messages read. Connection checks authenticate both transports without sending mail. SMTP delivery still goes through the existing `os.email.send` approval gate; external inbox text remains untrusted data.

The configured account takes precedence while enabled. With it disabled, existing Atomic Mail support remains available. The runtime pins the account identity, passwords, capabilities and tool availability at startup; saved changes take effect after restarting the agent. Each service operation also snapshots settings and credentials together, so a connection check cannot combine two accounts. Transport injection in [the service tests](email-service.test.ts) verifies settings, bounded reads, cancellation and credential-safe failures without a real account.

Checks: `npx vitest run src/email src/tools/os/email.test.ts`; `npm run lint`.
