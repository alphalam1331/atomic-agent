/** Launch the development desktop against this checkout on macOS/Linux. */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function prepareAgent({
  desktopDir = DESKTOP_DIR,
  platform = process.platform,
  nodePath = process.execPath,
  env = process.env,
  runBuild = spawnSync,
} = {}) {
  const launchEnv = { ...env };
  // Windows needs a real executable; keep its installed/bundled discovery.
  if (env.ATOMIC_AGENT_BIN || !["darwin", "linux"].includes(platform)) return launchEnv;

  const npmCli = env.npm_execpath;
  if (!npmCli || !isAbsolute(npmCli)) {
    throw new Error("Start the desktop with npm start or npm run dev (npm_execpath is missing).");
  }
  const repoDir = resolve(desktopDir, "..");
  const built = runBuild(nodePath, [npmCli, "run", "build"], {
    cwd: repoDir,
    env,
    stdio: "inherit",
  });
  if (built.error || built.status !== 0) {
    const error = new Error(`Could not build the checkout's agent${built.error ? `: ${built.error.message}` : "."}`);
    error.exitCode = built.status ?? 1;
    error.signal = built.signal;
    throw error;
  }
  const entry = join(repoDir, "dist", "cli", "index.js");
  if (!existsSync(entry)) throw new Error(`The agent build did not produce ${entry}.`);

  const launcher = join(desktopDir, ".dev", "atag");
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(nodePath)} --enable-source-maps ${shellQuote(entry)} "$@"\n`, { mode: 0o755 });
  chmodSync(launcher, 0o755);
  launchEnv.ATOMIC_AGENT_BIN = launcher;
  return launchEnv;
}

export async function startDesktop({
  desktopDir = DESKTOP_DIR,
  args = process.argv.slice(2),
  resolveElectron = () => require("electron"),
  spawnApp = spawn,
  signals = process,
  ...agentOptions
} = {}) {
  const env = prepareAgent({ desktopDir, ...agentOptions });
  const child = spawnApp(resolveElectron(), [".", ...args], {
    cwd: desktopDir,
    env,
    stdio: "inherit",
  });
  return new Promise((resolveExit, reject) => {
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const cleanup = () => {
      signals.off("SIGINT", interrupt);
      signals.off("SIGTERM", terminate);
    };
    signals.on("SIGINT", interrupt);
    signals.on("SIGTERM", terminate);
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => { cleanup(); resolveExit({ code: code ?? 1, signal }); });
  });
}

function exitLikeChild({ code, signal }) {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDesktop().then(exitLikeChild).catch((error) => {
    console.error(error.message);
    exitLikeChild({ code: error.exitCode ?? 1, signal: error.signal });
  });
}
