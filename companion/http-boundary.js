import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 128;
const MAX_MUTATIONS = 256;
const MAX_MUTATION_RESULT_BYTES = 64 * 1024;
const MUTATION_RESULT_BUDGET = 1024 * 1024;
const MUTATION_HEADER = "x-prioritizer-mutation";
const MUTATION_FAILURE = JSON.stringify({ error: "Companion request failed" });
const REQUEST_HEADER = "x-prioritizer-request";
const REQUEST_VALUE = "dashboard";
const METHODS = new Map([
  ["/api/session", "POST"],
  ["/api/dashboard", "GET"],
  ["/api/linear/issues", "POST"],
  ["/api/linear/issues/priority", "POST"],
  ["/api/linear/issues/done", "POST"],
]);
const SINGLE_HEADERS = new Set([
  "host", "origin", "authorization", "content-type", REQUEST_HEADER, MUTATION_HEADER,
  "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
  "access-control-request-method", "access-control-request-headers",
]);

// No CLI, filesystem, listener, or account access in this module. Tests supply
// synthetic handlers; the executable server wires in the real operations.
export function createCompanionHandler({ host, port, handlers, now = Date.now }) {
  if (!["127.0.0.1", "::1"].includes(host)) {
    throw new Error("HOST must be a loopback literal: 127.0.0.1 or ::1");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const authority = (name) => `${name}${port === 80 ? "" : `:${port}`}`;
  const hosts = new Set([authority(host === "::1" ? "[::1]" : host), authority("localhost")]);
  const sessions = new Map();

  function issueSession(origin) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(token);
    }
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + SESSION_TTL_MS;
    sessions.set(token, { origin, expiresAt, mutations: new Map(), resultBytes: 0 });
    return { token, expiresAt };
  }

  function authenticated(request, origin) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || "");
    if (!match) return false;
    const session = sessions.get(match[1]);
    if (!session) return false;
    if (session.expiresAt <= now()) {
      sessions.delete(match[1]);
      return false;
    }
    return session.origin === origin ? session : false;
  }

  async function retainMutation(session, path, operation, request) {
    let retained = { status: 500, body: MUTATION_FAILURE };
    try {
      const result = await operation(request);
      const status = result.ok ? (path === "/api/linear/issues" ? 201 : 200) : 400;
      // Serialize once, before sending headers, so later object mutation or a
      // failed response socket cannot change the outcome retained for this ID.
      const body = JSON.stringify(result);
      if (typeof body === "string" && Buffer.byteLength(body) <= MAX_MUTATION_RESULT_BYTES) {
        retained = { status, body };
      }
    } catch {
      // Retain generic failures too: a handler may have committed before throwing.
      // Never keep thrown objects, request bodies or credential-bearing headers.
    }
    session.resultBytes -= MAX_MUTATION_RESULT_BYTES - Buffer.byteLength(retained.body);
    return retained;
  }

  return async function handleRequest(request, response) {
    setSecurityHeaders(response);
    try {
      // Check the raw authority before parsing URLs or serving even public assets.
      // Forwarded headers never participate in the trust decision.
      if (hasDuplicateSecurityHeaders(request) || !hosts.has(request.headers.host)) {
        return sendJson(response, 403, { error: "Untrusted Host or duplicate header" });
      }
      if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) {
        return sendJson(response, 400, { error: "Invalid request target" });
      }
      const origin = `http://${request.headers.host}`;
      const url = new URL(request.url, origin);
      const suppliedOrigin = request.headers.origin;
      if (suppliedOrigin !== undefined && suppliedOrigin !== origin) {
        return sendJson(response, 403, { error: "Untrusted Origin" });
      }
      const method = METHODS.get(url.pathname);

      if (request.method === "OPTIONS") {
        if (!method || suppliedOrigin !== origin
          || request.headers["access-control-request-method"] !== method) {
          return sendJson(response, 403, { error: "Preflight denied" });
        }
        const mutation = method === "POST" && url.pathname !== "/api/session";
        const allowedHeaders = url.pathname === "/api/session"
          ? ["content-type", REQUEST_HEADER]
          : ["authorization", "content-type", REQUEST_HEADER, ...(mutation ? [MUTATION_HEADER] : [])];
        const requestedHeaders = String(request.headers["access-control-request-headers"] || "")
          .toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
        if (!requestedHeaders.includes(REQUEST_HEADER)
          || (url.pathname !== "/api/session" && !requestedHeaders.includes("authorization"))
          || (mutation && !requestedHeaders.includes(MUTATION_HEADER))
          || requestedHeaders.some((header) => !allowedHeaders.includes(header))) {
          return sendJson(response, 403, { error: "Preflight headers denied" });
        }
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Methods", method);
        response.setHeader("Access-Control-Allow-Headers", allowedHeaders.join(", "));
        response.writeHead(204);
        response.end();
        return;
      }

      if (method) {
        if (request.method !== method) {
          response.setHeader("Allow", method);
          return sendJson(response, 405, { error: "Method not allowed" });
        }
        // Only companion-hosted fetches may bootstrap or use a session. GET
        // fetches often omit Origin; POST must supply it. Missing Fetch Metadata
        // (including ordinary CLI callers), opaque origins, forms and navigations
        // fail closed. No extension origin is implicitly trusted.
        if (request.headers[REQUEST_HEADER] !== REQUEST_VALUE
          || request.headers["sec-fetch-site"] !== "same-origin"
          || !["cors", "same-origin"].includes(request.headers["sec-fetch-mode"])
          || request.headers["sec-fetch-dest"] !== "empty"
          || (method === "POST" && suppliedOrigin !== origin)) {
          return sendJson(response, 403, { error: "Companion-hosted fetch required" });
        }
        if (method === "POST"
          && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] || "")) {
          return sendJson(response, 415, { error: "application/json required" });
        }
        if (suppliedOrigin) response.setHeader("Access-Control-Allow-Origin", origin);
        if (url.pathname === "/api/session") {
          // Tokens are never in static HTML, cookies, URLs, logs or on disk.
          return sendJson(response, 201, issueSession(origin));
        }
        const session = authenticated(request, origin);
        if (!session) {
          return sendJson(response, 401, { error: "Companion session required" });
        }
        if (url.pathname === "/api/dashboard") {
          return sendJson(response, 200, await handlers.dashboard(url));
        }
        const mutationId = request.headers[MUTATION_HEADER];
        if (typeof mutationId !== "string" || !/^[a-f0-9]{32}$/.test(mutationId)) {
          return sendJson(response, 400, { error: "Valid mutation identifier required" });
        }
        // The first accepted delivery owns this session/route/ID, even if a
        // duplicate supplies a different body or query. It never runs again.
        const key = `${url.pathname}:${mutationId}`;
        let pending = session.mutations.get(key);
        if (!pending) {
          if (session.mutations.size >= MAX_MUTATIONS
            || session.resultBytes + MAX_MUTATION_RESULT_BYTES > MUTATION_RESULT_BUDGET) {
            return sendJson(response, 503, { error: "Companion mutation capacity reached" });
          }
          session.resultBytes += MAX_MUTATION_RESULT_BYTES;
          const operation = {
            "/api/linear/issues": handlers.createIssue,
            "/api/linear/issues/priority": handlers.updatePriority,
            "/api/linear/issues/done": handlers.markDone,
          }[url.pathname];
          // Reserve before dispatch or await: simultaneous native retransmissions
          // share this promise. Live IDs are never evicted to make room.
          pending = Promise.resolve().then(() => retainMutation(session, url.pathname, operation, request));
          session.mutations.set(key, pending);
        }
        const retained = await pending;
        return sendSerializedJson(response, retained.status, retained.body);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && await handlers.serveStatic(request, response)) return;
      return sendJson(response, 404, { error: "Not found" });
    } catch {
      // Do not expose credential-bearing request headers or CLI error internals.
      if (!response.headersSent) sendJson(response, 500, { error: "Companion request failed" });
      else response.end();
    }
  };
}

function hasDuplicateSecurityHeaders(request) {
  const seen = new Set();
  for (let index = 0; index < (request.rawHeaders || []).length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    if (!SINGLE_HEADERS.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Vary", "Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest");
  response.setHeader("X-Content-Type-Options", "nosniff");
  // Preserve Origin on same-origin POST fetches while suppressing referrers to
  // other sites. A no-referrer policy can make non-CORS POST Origin opaque.
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "connect-src 'self'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "frame-ancestors 'none'", "frame-src 'none'", "object-src 'none'",
    "base-uri 'none'", "form-action 'none'",
  ].join("; "));
}

function sendJson(response, status, body) {
  return sendSerializedJson(response, status, JSON.stringify(body));
}

function sendSerializedJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
}
