// Explicit, finite, manual browser fixture. NEVER import companion/server.js.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createCompanionHandler } from "../companion/http-boundary.js";
import { createSyntheticData } from "./browser/data.js";

const args = new Map();
const names = ["--host", "--port", "--untrusted-port", "--lifetime-seconds", "--expire-after-seconds"];
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!names.includes(key) || args.has(key) || process.argv[i + 1] === undefined) throw new Error("Invalid fixture arguments");
  args.set(key, process.argv[i + 1]);
}
const host = args.get("--host");
if (!["127.0.0.1", "::1"].includes(host)) throw new Error("Explicit --host 127.0.0.1 or ::1 required");
function numberArg(name, min, max, fallback) {
  const text = args.get(name) ?? fallback;
  if (!/^\d+$/.test(text || "")) throw new Error(`Invalid or missing ${name}`);
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Out of range ${name}`);
  return value;
}
const port = numberArg("--port", 0, 65535);
const untrustedPort = numberArg("--untrusted-port", 0, 65535);
if ([port, untrustedPort].some((value) => value !== 0 && value < 49152)
  || (port !== 0 && port === untrustedPort)) throw new Error("Choose distinct ports 49152..65535 or 0 for ephemeral allocation");
const lifetime = numberArg("--lifetime-seconds", 30, 1800);
const expireAfter = numberArg("--expire-after-seconds", 0, lifetime - 1, "0");
const hostname = host === "::1" ? "[::1]" : host;

// Each path points to an exact checked-in file. No directory serving, aliases,
// request-path joins, generated dashboard HTML, or arbitrary file access.
const assets = new Map([
  ["/pages/dashboard.html", ["../extension/pages/dashboard.html", "text/html"]],
  ["/pages/dashboard.css", ["../extension/pages/dashboard.css", "text/css"]],
  ["/pages/dashboard.js", ["../extension/pages/dashboard.js", "text/javascript"]],
  ["/pages/options.html", ["../extension/pages/options.html", "text/html"]],
  ["/pages/options.js", ["../extension/pages/options.js", "text/javascript"]],
  ["/pages/favicon.svg", ["../extension/pages/favicon.svg", "image/svg+xml"]],
  ["/lib/schedule.js", ["../extension/lib/schedule.js", "text/javascript"]],
  ["/lib/companion-client.js", ["../extension/lib/companion-client.js", "text/javascript"]],
  ["/fixture/probe.html", ["./browser/probe.html", "text/html"]],
  ["/fixture/probe.js", ["./browser/probe.js", "text/javascript"]],
  ...["issue", "project", "my-issues"].map((name) => [`/fixture/${name}`, ["./browser/navigation.html", "text/html"]]),
]);
const untrustedAssets = new Map([
  ["/", ["./browser/untrusted.html", "text/html"]],
  ["/untrusted.js", ["./browser/untrusted.js", "text/javascript"]],
]);
const loggablePaths = new Set([...assets.keys(), "/api/session", "/api/dashboard",
  "/api/linear/issues", "/api/linear/issues/priority", "/api/linear/issues/done",
  "/api/fixture-redirect", "/fixture/sink"]);

let boundary;
let data;
let origin;
let untrustedOrigin;
let clockOffset = 0;
let expiryScheduled = false;
let expiryTimer;
let lifetimeTimer;
let stopped = false;
const requests = [];
const calls = [];
const sinks = [];
const counts = { dashboard: 0, create: 0, priority: 0, done: 0 };
const append = (list, entry) => { list.push(entry); if (list.length > 200) list.shift(); };

function capture(request) {
  // Deliberately never capture raw headers, bearer values, cookies, bodies or
  // queries. Counts and this allowlist are sufficient for browser evidence.
  const h = request.headers;
  return { method: request.method, origin: h.origin ?? null,
    site: h["sec-fetch-site"] ?? null, mode: h["sec-fetch-mode"] ?? null,
    dest: h["sec-fetch-dest"] ?? null, contentType: h["content-type"] ?? null,
    requestMarker: h["x-prioritizer-request"] ?? null, authorizationPresent: Boolean(h.authorization),
    // A non-credential operation ID lets the lead correlate repeated deliveries.
    mutationId: /^[a-f0-9]{32}$/.test(h["x-prioritizer-mutation"] || "") ? h["x-prioritizer-mutation"] : null,
    preflightMethod: h["access-control-request-method"] ?? null,
    preflightHeaders: h["access-control-request-headers"] ?? null };
}
function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
async function asset(response, entry) {
  const bytes = await readFile(new URL(entry[0], import.meta.url));
  response.writeHead(200, { "Content-Type": `${entry[1]}; charset=utf-8`, "Cache-Control": "no-store" });
  response.end(bytes);
}
async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("Synthetic body limit exceeded");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Synthetic object required");
  return value;
}
async function mutate(name, request) {
  // This function is reachable only through the actual privileged boundary.
  // Count entry before body parsing so malformed unauthorized requests cannot
  // hide an accidental dispatch behind a later JSON failure.
  counts[name]++;
  const entry = { operation: name, ok: false, issueId: null, flow: "unparsed" };
  append(calls, entry);
  const value = await body(request);
  const result = name === "create" ? data.create(value) : data.update(value, name === "done");
  Object.assign(entry, { ok: result.ok, issueId: result.issue?.linearId || null,
    flow: name === "create" ? (value.suggestion ? "suggestion" : value.projectId ? "project" : "probe") : name });
  // Probe-only transport fault after a synthetic write. A native retry must get
  // the retained result without reentering here; either fetch success or rejection
  // is possible, but exactly one committed operation is the acceptance oracle.
  if (result.ok && value.fixtureDisconnect === true) request.socket.destroy();
  return result;
}
async function serveStatic(request, response) {
  const url = new URL(request.url, origin);
  if (url.pathname === "/fixture/state") {
    if (request.headers["sec-fetch-site"] !== "same-origin" || request.headers["x-fixture-inspect"] !== "1") {
      json(response, 403, { error: "Use the same-origin fixture probe" });
    } else {
      json(response, 200, { synthetic: true, origin, untrustedOrigin, clockOffset, expiryScheduled,
        expireAfterSeconds: expireAfter, counts, issues: data.snapshot(), calls, requests, sinks });
    }
    return true;
  }
  if (url.pathname === "/api/fixture-redirect") {
    // Fixture-only, no data/operation/session grant. Exercise the real client's
    // redirect:error behavior. The real companion has no such endpoint.
    response.writeHead(307, { Location: url.searchParams.get("to") === "same"
      ? `${origin}/fixture/sink` : `${untrustedOrigin}/sink` });
    response.end();
    return true;
  }
  if (url.pathname === "/fixture/sink") {
    append(sinks, { server: "trusted", ...capture(request) });
    json(response, 200, { synthetic: true });
    return true;
  }
  const entry = assets.get(url.pathname);
  if (!entry) return false;
  await asset(response, entry);
  return true;
}

const main = http.createServer((request, response) => {
  if (!boundary) return json(response, 503, { error: "Fixture starting" });
  const path = request.url.split("?")[0];
  if (path !== "/fixture/state") {
    const entry = { path: loggablePaths.has(path) ? path : "other", ...capture(request), status: null };
    append(requests, entry);
    response.once("finish", () => {
      entry.status = response.statusCode;
      if (!expiryScheduled && expireAfter > 0 && path === "/api/session" && response.statusCode === 201) {
        expiryScheduled = true;
        expiryTimer = setTimeout(() => { clockOffset = 8 * 60 * 60 * 1000 + 1000; }, expireAfter * 1000);
      }
    });
    response.once("close", () => { if (!response.writableFinished) entry.transportClosed = true; });
  }
  void boundary(request, response);
});
const untrusted = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  // This is a different origin even on the same machine. Only the two fixture
  // origins can be destinations of this test page's requests/forms/frames.
  response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; connect-src 'self' ${origin}; frame-src ${origin}; form-action ${origin}; base-uri 'none'`);
  try {
    if (request.headers.host !== new URL(untrustedOrigin).host) return json(response, 403, { error: "Fixture Host denied" });
    const url = new URL(request.url, untrustedOrigin);
    if (url.pathname === "/sink") {
      append(sinks, { server: "untrusted", ...capture(request) });
      return json(response, 200, { synthetic: true });
    }
    if (request.method !== "GET") return json(response, 405, { error: "GET only" });
    if (url.pathname === "/config") return json(response, 200, { origin });
    const entry = untrustedAssets.get(url.pathname);
    if (!entry) return json(response, 404, { error: "Not found" });
    await asset(response, entry);
  } catch {
    if (!response.headersSent) json(response, 500, { error: "Synthetic fixture error" });
    else response.end();
  }
});
const servers = [main, untrusted];
for (const server of servers) {
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
}
function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(lifetimeTimer);
  clearTimeout(expiryTimer);
  for (const server of servers) {
    if (server.listening) server.close();
    server.closeAllConnections();
  }
  console.log("Synthetic browser fixture stopped");
}
function listen(server, requestedPort) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: requestedPort, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

try {
  const actualPort = await listen(main, port);
  origin = `http://${hostname}:${actualPort}`;
  const actualUntrustedPort = await listen(untrusted, untrustedPort);
  untrustedOrigin = `http://${hostname}:${actualUntrustedPort}`;
  data = createSyntheticData(origin);
  boundary = createCompanionHandler({ host, port: actualPort, now: () => Date.now() + clockOffset,
    handlers: {
      dashboard: (url) => {
        counts.dashboard++;
        append(calls, { operation: "dashboard" });
        return data.dashboard(url.searchParams.get("date") || new Date().toISOString().slice(0, 10));
      },
      createIssue: (request) => mutate("create", request),
      updatePriority: (request) => mutate("priority", request),
      markDone: (request) => mutate("done", request),
      serveStatic,
    } });
  for (const server of servers) server.on("error", (error) => {
    console.error(`Fixture runtime failed: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  lifetimeTimer = setTimeout(stop, lifetime * 1000);
  console.log(JSON.stringify({ synthetic: true, dashboard: `${origin}/pages/dashboard.html`,
    probe: `${origin}/fixture/probe.html`, untrusted: `${untrustedOrigin}/`, lifetimeSeconds: lifetime,
    expireAfterSeconds: expireAfter }));
} catch (error) {
  // No retry, port scan, alternate bind, shell fallback, or environment lookup.
  console.error(`Fixture startup failed: ${error.message}`);
  process.exitCode = 1;
  stop();
}
