/** The subset of Chromium's AX protocol needed by the embedded browser. */
export interface EmbeddedAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name: string; value: { value?: unknown } }>;
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const ROLE_NAMES: Record<string, string> = {
  RootWebArea: "document", StaticText: "text", InlineTextBox: "text", LineBreak: "text",
};

/**
 * Serialize names/roles/states, never AX values. Editable descendants can carry
 * the entered value as StaticText, so they are omitted as well. Secret values
 * echoed outside their field are redacted by the caller before publication.
 */
export function embeddedAxLines(
  nodes: readonly EmbeddedAxNode[],
  refFor: (backendNodeId: number) => string,
  options: { rootId?: string; depth?: number } = {},
): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = options.rootId ? byId.get(options.rootId) : nodes[0];
  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (node: EmbeddedAxNode, depth: number) => {
    if (visited.has(node.nodeId) || depth > (options.depth ?? 80) || visited.size >= 12_000) return;
    visited.add(node.nodeId);
    const rawRole = String(node.role?.value ?? "generic");
    const role = ROLE_NAMES[rawRole] ?? rawRole.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
    const name = typeof node.name?.value === "string" ? node.name.value.replace(/\s+/g, " ").trim() : "";
    if (!node.ignored && rawRole !== "InlineTextBox") {
      const ref = node.backendDOMNodeId ? ` [ref=${refFor(node.backendDOMNodeId)}]` : "";
      const flags = (node.properties ?? []).flatMap((property) => {
        if (["disabled", "selected", "expanded", "checked", "required", "level"].includes(property.name)) {
          return [` [${property.name}=${JSON.stringify(property.value.value)}]`];
        }
        return [];
      }).join("");
      lines.push(`${"  ".repeat(Math.min(depth, 80))}- ${role || "generic"}${name ? ` ${JSON.stringify(name)}` : ""}${ref}${flags}`);
    }
    if (FIELD_ROLES.has(role) || node.properties?.some((property) => property.name === "editable" && property.value.value)) return;
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, depth + (node.ignored ? 0 : 1));
    }
  };
  if (root) visit(root, 0);
  if (visited.size >= 12_000) lines.push("… [accessibility node limit reached; read a region for more]");
  return lines.join("\n");
}
