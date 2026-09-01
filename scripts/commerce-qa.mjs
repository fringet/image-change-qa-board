import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, codeStamp, readJson, servicePaths, stateDirectory } from "./board-registry.mjs";

function values(args, name) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) output.push(args[index + 1]);
  }
  return output;
}

function value(args, name, required = false) {
  const matches = values(args, name);
  if (matches.length) return matches[matches.length - 1];
  if (required) throw new Error(`Missing required argument: ${name}`);
  return null;
}

function has(args, name) {
  return args.includes(name);
}

function print(valueToPrint) {
  process.stdout.write(`${JSON.stringify(valueToPrint, null, 2)}\n`);
}

async function request(service, route, options = {}) {
  const response = await fetch(`http://${service.host}:${service.port}${route}`, {
    ...options,
    headers: {
      "X-Commerce-QA-Key": service.key,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeout || 5_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Commerce QA service returned ${response.status}`);
  return payload;
}

async function healthy(service) {
  if (!service?.host || !service?.port || !service?.key) return false;
  try {
    const result = await request(service, "/api/health", { timeout: 700 });
    return result.ok && (!service.instanceId || result.instanceId === service.instanceId);
  } catch {
    return false;
  }
}

async function waitForService(paths, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const service = await readJson(paths.service, null);
    if (await healthy(service)) return service;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Commerce QA service did not start. Check ${paths.log}`);
}

async function ensureService(stateDir, preferredPort) {
  const paths = servicePaths(stateDir);
  await fsp.mkdir(stateDir, { recursive: true });
  const existing = await readJson(paths.service, null);
  if (await healthy(existing)) {
    const stamp = await codeStamp();
    if (existing.codeStamp === stamp) return { service: existing, started: false };
    // The skill changed on disk. Retire the old process so every chat gets the
    // behaviour the files describe instead of whatever was loaded first.
    await request(existing, "/api/shutdown", { method: "POST" }).catch(() => {});
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && await healthy(existing)) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    await fsp.rm(paths.service, { force: true }).catch(() => {});
    await fsp.rm(paths.lock, { force: true }).catch(() => {});
  }

  let ownsLock = false;
  try {
    const handle = await fsp.open(paths.lock, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await handle.close();
    ownsLock = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fsp.stat(paths.lock).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 15_000) {
      await fsp.rm(paths.lock, { force: true });
      return ensureService(stateDir, preferredPort);
    }
  }

  if (!ownsLock) return { service: await waitForService(paths), started: false };

  const key = randomBytes(24).toString("base64url");
  const serviceScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "qa-service.mjs");
  const logFd = fs.openSync(paths.log, "a");
  try {
    const child = spawn(process.execPath, [serviceScript, "--state-dir", stateDir, "--port", String(preferredPort), "--key", key], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  try {
    return { service: await waitForService(paths), started: true };
  } catch (error) {
    await fsp.rm(paths.lock, { force: true });
    throw error;
  }
}

async function runScript(scriptName, args) {
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const raw = stderr.trim() || stdout.trim() || `${scriptName} exited with ${code}`;
        const concise = raw.match(/(?:^|\n)Error: ([^\n]+)/)?.[1] || raw;
        return reject(new Error(concise));
      }
      const trimmed = stdout.trim();
      try {
        resolve(JSON.parse(trimmed));
      } catch {
        resolve({ output: trimmed });
      }
    });
  });
}

async function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function serviceArgs(args) {
  const stateDir = stateDirectory(value(args, "--state-dir"));
  const port = Number(value(args, "--service-port") || process.env.COMMERCE_QA_PORT || DEFAULT_PORT);
  return { stateDir, port };
}

async function register(service, args, command) {
  const projectRoot = path.resolve(value(args, "--project", true));
  const openIntent = has(args, "--no-open")
    ? "never"
    : has(args, "--open") || command === "open"
      ? "force"
      : command === "add"
        ? "if-needed"
        : "never";
  return request(service, "/api/boards/register", {
    method: "POST",
    body: JSON.stringify({
      projectRoot,
      name: value(args, "--board"),
      roundFilter: value(args, "--round"),
      sourceFilter: value(args, "--filter-source"),
      allRounds: has(args, "--all-rounds"),
      openIntent,
    }),
  });
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    print({
      usage: "commerce-qa <add|truth|open|url|list|status|read|applied|stop> [options]",
      examples: [
        "commerce-qa add --project <root> --product <name> --title <title> --after <image> --finding <qa> --request <request>",
        "commerce-qa truth --project <root> --sku <sku> --identity <image> --identity-label <label>",
        "commerce-qa truth --project <root> --list",
        "commerce-qa open --project <root>",
        "commerce-qa read --project <root> --unapplied",
        "commerce-qa applied --project <root> --submission <id>",
      ],
    });
    return;
  }

  if (command === "read") {
    const selectionArgs = has(args, "--submission") || has(args, "--unapplied") ? args : [...args, "--unapplied"];
    print(await runScript("read-review.mjs", selectionArgs));
    return;
  }
  if (command === "applied") {
    if (!value(args, "--submission")) throw new Error("Provide --submission <id>");
    print(await runScript("read-review.mjs", [...args, "--mark-applied"]));
    return;
  }

  if (command === "truth") {
    const registered = await runScript("register-truth.mjs", args);
    if (has(args, "--list")) {
      print(registered);
      return;
    }
    const { stateDir: truthStateDir, port: truthPort } = serviceArgs(args);
    let refreshed = false;
    try {
      const service = await readJson(servicePaths(truthStateDir).service, null);
      if (await healthy(service)) {
        await register(service, [...args, "--no-open"], "truth");
        refreshed = true;
      }
    } catch {
      // A truth update is recorded on disk even when no board is currently open.
    }
    print({ contract: "passed", truth: registered, boardRefreshed: refreshed });
    return;
  }

  const { stateDir, port } = serviceArgs(args);
  const paths = servicePaths(stateDir);
  if (command === "stop") {
    const service = await readJson(paths.service, null);
    if (!(await healthy(service))) {
      print({ stopped: false, reason: "Commerce QA service is not running" });
      return;
    }
    print(await request(service, "/api/shutdown", { method: "POST" }));
    return;
  }

  const ensured = await ensureService(stateDir, port);
  if (command === "status") {
    const health = await request(ensured.service, "/api/health");
    const boards = await request(ensured.service, "/api/boards");
    print({ ...health, startedNow: ensured.started, ...boards });
    return;
  }
  if (command === "list") {
    print(await request(ensured.service, "/api/boards"));
    return;
  }
  if (!['add', 'open', 'url'].includes(command)) throw new Error(`Unknown command: ${command}`);

  let recorded = null;
  if (command === "add") recorded = await runScript("record-change.mjs", args);
  const registration = await register(ensured.service, args, command);
  if (registration.shouldOpen) await openUrl(registration.url);
  print({
    contract: "passed",
    service: { reused: !ensured.started, port: ensured.service.port },
    board: { id: registration.id, name: registration.name, url: registration.url },
    opened: registration.shouldOpen,
    recorded,
  });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ contract: "failed", error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
