export { EmailService, EmailServiceError, readEmailPassword, EMAIL_IMAP_PASSWORD_ENV, EMAIL_SMTP_PASSWORD_ENV, type EmailServiceOptions, type EmailReadiness } from "./email-service.js";
export type { EmailImapClient, EmailSmtpClient, EmailSmtpOptions, EmailOutgoingMessage } from "./email-transports.js";
