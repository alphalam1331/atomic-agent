import type { FetchMessageObject, MessageStructureObject } from "imapflow";

export const EMAIL_PREVIEW_BYTES = 1024;

/** Ignore attachments and nested forwarded messages when finding a preview. */
export function previewPart(node: MessageStructureObject | undefined): MessageStructureObject | undefined {
  if (!node || node.disposition?.toLowerCase() === "attachment") return undefined;
  if (node.type.toLowerCase() === "text/plain") return node;
  if (!node.type.toLowerCase().startsWith("multipart/")) return undefined;
  for (const child of node.childNodes ?? []) {
    const part = previewPart(child);
    if (part) return part;
  }
  return undefined;
}

export function messagePreview(message: FetchMessageObject | false, part: MessageStructureObject): string {
  const key = part.part || "TEXT";
  const raw = message && message.bodyParts?.get(key);
  if (!raw) return "";
  // The server is asked for a bounded prefix; cap again at the boundary.
  let bytes = raw.subarray(0, EMAIL_PREVIEW_BYTES);
  if (!message.binaryParts?.has(key)) {
    if (part.encoding?.toLowerCase() === "base64") bytes = Buffer.from(bytes.toString("ascii"), "base64");
    else if (part.encoding?.toLowerCase() === "quoted-printable") {
      bytes = Buffer.from(bytes.toString("latin1").replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    }
  }
  let text: string;
  try { text = new TextDecoder(part.parameters?.charset || "utf-8").decode(bytes); }
  catch { text = bytes.toString("utf8"); }
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().slice(0, 160);
}
