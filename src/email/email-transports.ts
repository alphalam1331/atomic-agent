import { ImapFlow, type ImapFlowOptions, type FetchMessageObject, type FetchQueryObject } from "imapflow";
import nodemailer from "nodemailer";
import SMTPConnection from "nodemailer/lib/smtp-connection";

/** Narrow transport seams: tests never need a network or real account. */
export interface EmailImapClient {
  mailbox: { exists: number } | false;
  connect(): Promise<unknown>;
  getMailboxLock(path: string, options: { readOnly: boolean }): Promise<{ release(): void }>;
  fetchAll(range: string, query: FetchQueryObject): Promise<FetchMessageObject[]>;
  fetchOne(uid: string, query: FetchQueryObject, options: { uid: boolean }): Promise<FetchMessageObject | false>;
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface EmailSmtpOptions extends SMTPConnection.Options {
  host: string;
  port: number;
  auth: { user: string; pass: string };
  disableFileAccess: true;
  disableUrlAccess: true;
}

export interface EmailOutgoingMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  signal: AbortSignal;
}

export interface EmailSmtpClient {
  verify(): Promise<unknown>;
  sendMail(message: EmailOutgoingMessage): Promise<{ messageId: string }>;
  close(): void;
}

export type CreateEmailImapClient = (options: ImapFlowOptions) => EmailImapClient;
export type CreateEmailSmtpClient = (options: EmailSmtpOptions) => EmailSmtpClient;

export const createEmailImapClient: CreateEmailImapClient = (options) => new ImapFlow(options);

export const createEmailSmtpClient: CreateEmailSmtpClient = (options) => {
  const transport = nodemailer.createTransport(options);
  // Nodemailer's verify() hides its connection, and transport.close() does
  // not close that socket. Own this connection so cancelling a check does.
  let verification: SMTPConnection | undefined;
  return {
    verify: () => new Promise<void>((resolve, reject) => {
      const connection = new SMTPConnection(options);
      verification = connection;
      connection.on("error", reject);
      connection.on("end", () => reject(new Error("SMTP connection closed")));
      connection.connect((error) => {
        if (error) { reject(error); return; }
        connection.login(options.auth, (loginError) => {
          if (loginError) reject(loginError);
          else resolve();
        });
      });
    }),
    // Nodemailer >=10.5 honours signal during delivery and closes the
    // delivering connection. The older DefinitelyTyped shape omits it.
    sendMail: (message) => transport.sendMail(message),
    close: () => { verification?.close(); transport.close(); },
  };
};
