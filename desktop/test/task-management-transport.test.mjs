import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentClient } = require("../out/main/agent-client.js");

test("task writes use their authenticated HTTP routes and preserve server conflicts", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, token: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const conflict = req.url.endsWith("/busy");
      res.writeHead(conflict ? 409 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(conflict ? { error: { message: "Only pending tasks can be edited." } } : { ok: true }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = "task-test-token";
  try {
    const patch = { userMessage: "check again", schedule: { kind: "cron", expression: "0 9 * * *" }, notify: null };
    await client.updateTask("task/1", patch);
    await client.stopTask("task/1");
    await client.removeTask("task/1");
    await client.cancelTask("task/1");
    assert.deepEqual(seen, [
      { method: "PATCH", url: "/api/tasks/task%2F1", token: "Bearer task-test-token", body: patch },
      { method: "POST", url: "/api/tasks/task%2F1/stop", token: "Bearer task-test-token", body: null },
      { method: "DELETE", url: "/api/tasks/task%2F1/record", token: "Bearer task-test-token", body: null },
      { method: "DELETE", url: "/api/tasks/task%2F1", token: "Bearer task-test-token", body: null },
    ]);
    await assert.rejects(client.updateTask("busy", patch), /Only pending tasks can be edited/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
