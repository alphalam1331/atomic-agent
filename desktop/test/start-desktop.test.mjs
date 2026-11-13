import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareAgent, startDesktop } from "../scripts/start-desktop.mjs";

function fixture(t, name = "checkout") {
  const temp = mkdtempSync(join(tmpdir(), "atomic-desktop-start-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repoDir = join(temp, name);
  const desktopDir = join(repoDir, "desktop");
  const entry = join(repoDir, "dist", "cli", "index.js");
  mkdirSync(desktopDir, { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  return { temp, repoDir, desktopDir, entry };
}

function fakeChild() {
  const child = new EventEmitter();
  child.kill = (signal) => { queueMicrotask(() => child.emit("close", null, signal)); return true; };
  return child;
}

test("an explicit agent override skips checkout preparation and reaches Electron unchanged", async (t) => {
  const { desktopDir } = fixture(t);
  const env = { ATOMIC_AGENT_BIN: "/custom/agent", KEEP: "present" };
  const child = fakeChild();
  let launch;
  const done = startDesktop({
    desktopDir, env, platform: "linux", args: ["--dev", "--workspace=a b"],
    runBuild() { assert.fail("must not build an overridden agent"); },
    resolveElectron: () => "/electron/app",
    spawnApp(...args) { launch = args; queueMicrotask(() => child.emit("close", 7, null)); return child; },
    signals: new EventEmitter(),
  });
  assert.deepEqual(await done, { code: 7, signal: null });
  assert.deepEqual(launch, ["/electron/app", [".", "--dev", "--workspace=a b"], { cwd: desktopDir, env, stdio: "inherit" }]);
  assert.equal(existsSync(join(desktopDir, ".dev")), false);
});

test("a failed backend build prevents Electron launch and launcher generation", async (t) => {
  const { desktopDir, repoDir } = fixture(t);
  await assert.rejects(startDesktop({
    desktopDir, platform: "linux", nodePath: "/chosen/node",
    env: { npm_execpath: "/chosen/npm-cli.js" },
    runBuild(file, args, options) {
      assert.equal(file, "/chosen/node");
      assert.deepEqual(args, ["/chosen/npm-cli.js", "run", "build"]);
      assert.equal(options.cwd, repoDir);
      return { status: 9, signal: null };
    },
    resolveElectron() { assert.fail("must not resolve Electron after a failed build"); },
    spawnApp() { assert.fail("must not launch after a failed build"); },
  }), (error) => error.exitCode === 9 && /Could not build/.test(error.message));
  assert.equal(existsSync(join(desktopDir, ".dev")), false);
});

test("a successful checkout build supplies the same local agent to the Electron process", async (t) => {
  const { desktopDir, entry } = fixture(t);
  const child = fakeChild();
  const events = [];
  const done = startDesktop({
    desktopDir, platform: "darwin", nodePath: "/selected/node", args: ["--dev"],
    env: { npm_execpath: "/selected/npm-cli.js", KEEP: "present" },
    runBuild() {
      events.push("build");
      writeFileSync(entry, "// compiled backend\n");
      return { status: 0 };
    },
    resolveElectron() { events.push("resolve Electron"); return "/electron/app"; },
    spawnApp(file, args, options) {
      events.push("launch Electron");
      assert.equal(file, "/electron/app");
      assert.deepEqual(args, [".", "--dev"]);
      assert.equal(options.cwd, desktopDir);
      assert.equal(options.env.KEEP, "present");
      assert.equal(options.env.ATOMIC_AGENT_BIN, join(desktopDir, ".dev", "atag"));
      assert.ok(readFileSync(options.env.ATOMIC_AGENT_BIN, "utf8").includes("'/selected/node'"));
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    signals: new EventEmitter(),
  });
  assert.deepEqual(await done, { code: 0, signal: null });
  assert.deepEqual(events, ["build", "resolve Electron", "launch Electron"]);
});

test("the generated launcher preserves literal paths, arguments and the selected workspace", { skip: process.platform === "win32" }, (t) => {
  const { temp, repoDir, desktopDir, entry } = fixture(t, "checkout ' $HOME `literal`");
  const nodePath = join(temp, "node ' $HOME `literal`");
  symlinkSync(process.execPath, nodePath);
  const workspace = join(temp, "a different workspace");
  mkdirSync(workspace);
  const env = { ...process.env, npm_execpath: "/npm with spaces/npm-cli.js", ATOMIC_AGENT_BIN: "" };
  let built = false;
  const launchEnv = prepareAgent({
    desktopDir, platform: "linux", nodePath, env,
    runBuild(file, args, options) {
      assert.equal(file, nodePath);
      assert.deepEqual(args, [env.npm_execpath, "run", "build"]);
      assert.equal(options.cwd, repoDir);
      writeFileSync(entry, "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n");
      built = true;
      return { status: 0 };
    },
  });
  assert.equal(built, true);
  assert.equal(env.ATOMIC_AGENT_BIN, "", "the caller's environment is unchanged");
  assert.equal(statSync(launchEnv.ATOMIC_AGENT_BIN).mode & 0o111, 0o111);
  assert.ok(readFileSync(launchEnv.ATOMIC_AGENT_BIN, "utf8").startsWith("#!/bin/sh\nexec "));
  const args = ["models", "a b", "'quoted'", "$HOME", "`literal`", "", "line\nbreak"];
  const result = spawnSync(launchEnv.ATOMIC_AGENT_BIN, args, { cwd: workspace, env: launchEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, cwd: workspace });
});

test("Windows retains executable discovery without building or generating a cmd shim", async (t) => {
  const { desktopDir } = fixture(t);
  const child = fakeChild();
  const env = { KEEP: "present" };
  const done = startDesktop({
    desktopDir, platform: "win32", env, args: [],
    runBuild() { assert.fail("Windows keeps installed executable discovery"); },
    resolveElectron: () => "C:\\Electron\\electron.exe",
    spawnApp(file, args, options) {
      assert.equal(file, "C:\\Electron\\electron.exe");
      assert.deepEqual(options.env, env);
      assert.equal(options.env.ATOMIC_AGENT_BIN, undefined);
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    signals: new EventEmitter(),
  });
  assert.deepEqual(await done, { code: 0, signal: null });
  assert.equal(existsSync(join(desktopDir, ".dev")), false);
});

test("termination is forwarded to Electron and signal listeners are removed on exit", async (t) => {
  const { desktopDir } = fixture(t);
  const child = fakeChild();
  const signals = new EventEmitter();
  const done = startDesktop({
    desktopDir, env: { ATOMIC_AGENT_BIN: "/custom/agent" }, args: [], signals,
    resolveElectron: () => "/electron/app", spawnApp: () => child,
  });
  signals.emit("SIGTERM");
  assert.deepEqual(await done, { code: 1, signal: "SIGTERM" });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});
