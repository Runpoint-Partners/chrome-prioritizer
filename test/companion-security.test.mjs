import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionHandler } from "../companion/http-boundary.js";
import { createCompanionClient } from "../extension/lib/companion-client.js";

// Entirely synthetic requests/responses: no server import/listen, subprocess,
// account CLI, network, profile, environment credential, or filesystem access.
const ORIGIN = "http://127.0.0.1:4128";
const MUTATIONS = [
  "/api/linear/issues",
  "/api/linear/issues/priority",
  "/api/linear/issues/done",
];

function fixture({ host = "127.0.0.1", port = 4128, handlerOverrides = {} } = {}) {
  let time = 100000;
  const calls = [];
  const operation = (name) => async () => {
    calls.push(name);
    return { ok: true, synthetic: name };
  };
  const handler = createCompanionHandler({
    host, port, now: () => time,
    handlers: {
      dashboard: async (url) => {
        calls.push("dashboard");
        return { synthetic: "dashboard", date: url.searchParams.get("date") };
      },
      createIssue: operation("create"),
      updatePriority: operation("priority"),
      markDone: operation("done"),
      serveStatic: async (_request, response) => {
        calls.push("static");
        response.writeHead(200);
        response.end("public shell, no session");
        return true;
      },
      ...handlerOverrides,
    },
  });
  return { handler, calls, now: () => time, advance: (amount) => { time += amount; } };
}

async function request(f, {
  path = "/api/dashboard", method = "GET", headers = {}, rawHeaders,
  body: bodyText = "", onBodyRead = () => {}, onResponseEnd = () => {},
} = {}) {
  const merged = { host: "127.0.0.1:4128", ...headers };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const response = {
    headers: {}, headersSent: false, status: null, body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, values = {}) {
      this.status = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
    },
    end(value = "") { onResponseEnd(value); this.body = value; },
  };
  await f.handler({
    method, url: path, headers: merged,
    rawHeaders: rawHeaders || Object.entries(merged).flat(),
    async *[Symbol.asyncIterator]() { onBodyRead(); yield bodyText; },
  }, response);
  return response;
}

let mutationSequence = 0;
function browserHeaders(token, origin = ORIGIN) {
  return {
    origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "same-origin",
    "sec-fetch-dest": "empty",
    "x-prioritizer-request": "dashboard",
    "content-type": "application/json",
    "x-prioritizer-mutation": (++mutationSequence).toString(16).padStart(32, "0"),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function bootstrap(f, headers = {}) {
  const response = await request(f, {
    path: "/api/session", method: "POST", headers: { ...browserHeaders(), ...headers },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["set-cookie"], undefined);
  const session = JSON.parse(response.body);
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  return session;
}

test("hosted UI session permits dashboard and all three Linear operations", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  assert.deepEqual(f.calls, []);
  const read = await request(f, {
    path: "/api/dashboard?date=2026-11-14",
    headers: { ...browserHeaders(token), origin: undefined },
  });
  assert.equal(read.status, 200); // same-origin GET may omit Origin
  assert.deepEqual(JSON.parse(read.body), { synthetic: "dashboard", date: "2026-11-14" });
  for (const path of MUTATIONS) {
    const write = await request(f, { path, method: "POST", headers: browserHeaders(token) });
    assert.equal(write.status, path === MUTATIONS[0] ? 201 : 200);
  }
  assert.deepEqual(f.calls, ["dashboard", "create", "priority", "done"]);
});

test("missing, malformed, query, cookie and invented tokens do not reach operations", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  for (const authorization of [undefined, "Bearer bad", `Basic ${token}`, `Bearer ${"A".repeat(43)}`]) {
    for (const path of ["/api/dashboard", ...MUTATIONS]) {
      const response = await request(f, {
        path: `${path}?token=${token}`,
        method: path === "/api/dashboard" ? "GET" : "POST",
        headers: { ...browserHeaders(), authorization, cookie: `session=${token}` },
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.includes(token), false);
    }
  }
  assert.deepEqual(f.calls, []);
});

test("cross-origin reads, writes and bootstrap fail even with a valid stolen token", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  for (const origin of ["https://unrelated.example", "null", "http://localhost:4128",
    "http://127.0.0.1:4173", "chrome-extension://" + "a".repeat(32), ORIGIN + "/"]) {
    for (const path of ["/api/session", "/api/dashboard", ...MUTATIONS]) {
      const response = await request(f, {
        path, method: path === "/api/dashboard" ? "GET" : "POST",
        headers: browserHeaders(token, origin),
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
      assert.equal(response.body.includes(token), false);
    }
  }
  assert.deepEqual(f.calls, []);
});

test("Host validation blocks DNS rebinding, forwarded authority, duplicates and absolute targets", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  for (const host of [undefined, "evil.example:4128", "127.0.0.1:9999", "127.0.0.1:4128.evil.example",
    "localhost.:4128", "127.1:4128", "127.0.0.1:4128@evil.example", "[::1]:4128"]) {
    for (const path of ["/pages/dashboard.html", "/api/session", "/api/dashboard", ...MUTATIONS]) {
      const response = await request(f, {
        path, method: path === "/api/session" || MUTATIONS.includes(path) ? "POST" : "GET",
        headers: { ...browserHeaders(token), host, "x-forwarded-host": "127.0.0.1:4128" },
      });
      assert.equal(response.status, 403);
    }
  }
  const duplicate = await request(f, {
    headers: browserHeaders(token),
    rawHeaders: ["Host", "evil.example", "Host", "127.0.0.1:4128"],
  });
  assert.equal(duplicate.status, 403);
  for (const path of [ORIGIN + "/api/dashboard", "//evil.example/api/dashboard", "/\\evil.example/api/dashboard"]) {
    assert.equal((await request(f, { path, headers: browserHeaders(token) })).status, 400);
  }
  assert.deepEqual(f.calls, []);
});

test("form types, no-cors, navigations, absent metadata and missing POST Origin fail closed", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  for (const change of [
    { origin: undefined },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    { "sec-fetch-site": undefined },
    { "sec-fetch-mode": "no-cors" },
    { "sec-fetch-mode": "navigate" },
    { "sec-fetch-mode": undefined },
    { "sec-fetch-dest": "document" },
    { "sec-fetch-dest": undefined },
    { "x-prioritizer-request": undefined },
    { "content-type": "text/plain" },
    { "content-type": "application/x-www-form-urlencoded" },
    { "content-type": "multipart/form-data; boundary=synthetic" },
    { "content-type": undefined },
  ]) {
    for (const path of ["/api/session", ...MUTATIONS]) {
      const response = await request(f, { path, method: "POST", headers: { ...browserHeaders(token), ...change } });
      assert.equal(response.status, Object.hasOwn(change, "content-type") ? 415 : 403);
    }
  }
  assert.equal((await request(f, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  assert.deepEqual(f.calls, []);
});

test("preflight allows only the exact hosted origin, method and header set, without invoking handlers", async () => {
  const f = fixture();
  for (const path of ["/api/session", "/api/dashboard", ...MUTATIONS]) {
    const method = path === "/api/dashboard" ? "GET" : "POST";
    const headers = {
      origin: ORIGIN,
      "access-control-request-method": method,
      "access-control-request-headers": path === "/api/session"
        ? "content-type, x-prioritizer-request"
        : `authorization, content-type, x-prioritizer-request${MUTATIONS.includes(path) ? ", x-prioritizer-mutation" : ""}`,
    };
    const allowed = await request(f, { path, method: "OPTIONS", headers });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.body, "");
    assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(allowed.headers["access-control-allow-methods"], method);
    assert.equal(allowed.headers["access-control-allow-credentials"], undefined);
    for (const change of [
      { origin: "https://unrelated.example" }, { origin: "null" }, { origin: undefined },
      { "access-control-request-method": "DELETE" },
      { "access-control-request-headers": "authorization, x-prioritizer-request, x-extra" },
      { "access-control-request-headers": "content-type" },
    ]) {
      const denied = await request(f, { path, method: "OPTIONS", headers: { ...headers, ...change } });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers["access-control-allow-origin"], undefined);
    }
  }
  assert.deepEqual(f.calls, []);
});

test("sessions are unique, expire, are bounded, and do not survive a new handler or alias change", async () => {
  const f = fixture();
  const first = await bootstrap(f);
  const second = await bootstrap(f);
  assert.notEqual(first.token, second.token);
  const restart = fixture();
  assert.equal((await request(restart, { headers: browserHeaders(first.token) })).status, 401);
  assert.equal((await request(f, { headers: {
    ...browserHeaders(first.token, "http://localhost:4128"), host: "localhost:4128",
  } })).status, 401);
  const alias = await bootstrap(f, { host: "localhost:4128", origin: "http://localhost:4128" });
  assert.equal((await request(f, { headers: {
    ...browserHeaders(alias.token, "http://localhost:4128"), host: "localhost:4128",
  } })).status, 200);
  f.advance(8 * 60 * 60 * 1000);
  assert.equal((await request(f, { headers: browserHeaders(first.token) })).status, 401);
  const oldest = await bootstrap(f);
  for (let i = 0; i < 128; i++) await bootstrap(f);
  assert.equal((await request(f, { headers: browserHeaders(oldest.token) })).status, 401);
});

test("only loopback binds are accepted, including IPv6 and configured ports", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.1", "example.com", "localhost"]) {
    assert.throws(() => fixture({ host }), /HOST must/);
  }
  for (const port of [0, -1, 65536, 4128.1, NaN]) {
    assert.throws(() => fixture({ port }), /PORT must/);
  }
  for (const [host, port, authority] of [["::1", 5000, "[::1]:5000"], ["127.0.0.1", 80, "127.0.0.1"]]) {
    const f = fixture({ host, port });
    const { token } = await bootstrap(f, { host: authority, origin: `http://${authority}` });
    assert.equal((await request(f, { headers: {
      ...browserHeaders(token, `http://${authority}`), host: authority,
    } })).status, 200);
  }
});

test("public shell/health contain no token and API navigation cannot invoke privileged handlers", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  const shell = await request(f, { path: "/pages/dashboard.html" });
  assert.equal(shell.status, 200);
  assert.equal(shell.body.includes(token), false);
  assert.match(shell.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(shell.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(shell.headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(shell.headers["referrer-policy"], "same-origin");
  assert.equal(shell.headers["cache-control"], "no-store");
  assert.equal(shell.headers["access-control-allow-origin"], undefined);
  assert.equal((await request(f, { path: "/health" })).body, '{"ok":true}');
  for (const path of ["/api/session", ...MUTATIONS]) {
    assert.equal((await request(f, { path })).status, 405);
  }
  assert.equal((await request(f)).status, 403);
  assert.deepEqual(f.calls, ["static"]);
});

function clientFixture(f, { deliverMutationTwice = false } = {}) {
  const requests = [];
  const client = createCompanionClient({
    origin: ORIGIN, now: f.now,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const parsed = new URL(url);
      const headers = Object.fromEntries(new Headers(options.headers));
      // Model headers added by the browser, which page JavaScript cannot forge.
      Object.assign(headers, {
        "sec-fetch-site": "same-origin", "sec-fetch-mode": "same-origin", "sec-fetch-dest": "empty",
      });
      if (options.method === "POST") headers.origin = ORIGIN;
      const deliver = () => request(f, { path: parsed.pathname + parsed.search, method: options.method || "GET", headers, body: options.body });
      let response = await deliver();
      // Model transport retransmission beneath a single fetchImpl invocation.
      if (deliverMutationTwice && MUTATIONS.includes(parsed.pathname)) response = await deliver();
      return { ok: response.status >= 200 && response.status < 300, status: response.status,
        json: async () => JSON.parse(response.body) };
    },
  });
  return { client, requests };
}

test("client bootstraps once for concurrent calls, uses bearer headers and renews expiry", async () => {
  const f = fixture();
  const { client, requests } = clientFixture(f);
  await Promise.all([client("/api/dashboard"), client("/api/dashboard?date=2026-11-14")]);
  assert.equal(requests.filter(({ url }) => url.endsWith("/api/session")).length, 1);
  await client(MUTATIONS[0], { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.deepEqual(f.calls, ["dashboard", "dashboard", "create"]);
  for (const { url, options } of requests) {
    assert.equal(options.mode, "same-origin");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.referrerPolicy, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.equal(url.includes("token="), false);
    if (!url.endsWith("/api/session")) assert.match(options.headers.get("authorization"), /^Bearer /);
  }
  f.advance(8 * 60 * 60 * 1000);
  await client("/api/dashboard");
  assert.equal(requests.filter(({ url }) => url.endsWith("/api/session")).length, 2);
});

test("client rejects credential forwarding destinations before fetching", async () => {
  const f = fixture();
  const { client, requests } = clientFixture(f);
  for (const path of ["https://evil.example/api/dashboard", "http://localhost:4128/api/dashboard",
    "//evil.example/api/dashboard", "/api/session", "/pages/dashboard.html",
    "http://name:secret@127.0.0.1:4128/api/dashboard", "/api/dashboard#token"]) {
    await assert.rejects(client(path), /Invalid companion request URL/);
  }
  assert.deepEqual(requests, []);
  for (const origin of ["https://evil.example", "http://127.0.0.1:4128/path", "null", "chrome-extension://" + "a".repeat(32)]) {
    assert.throws(() => createCompanionClient({ origin }), /loopback companion|Invalid URL/);
  }
});

test("client clears a rejected session without replaying a mutation or a network failure", async () => {
  let bootstraps = 0;
  let writes = 0;
  let failNetwork = false;
  const client = createCompanionClient({
    origin: ORIGIN, now: () => 100000,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/session")) {
        bootstraps++;
        return { ok: true, json: async () => ({ token: "A".repeat(43), expiresAt: 200000 }) };
      }
      writes++;
      if (failNetwork) throw new Error("synthetic network failure");
      return { status: 401 };
    },
  });
  await assert.rejects(client(MUTATIONS[0], { method: "POST" }), /session expired/);
  assert.equal(writes, 1);
  assert.equal(bootstraps, 1);
  failNetwork = true;
  await assert.rejects(client(MUTATIONS[0], { method: "POST" }), /synthetic network failure/);
  assert.equal(writes, 2);
  assert.equal(bootstraps, 2);
});

test("client fails closed on an invalid or expired bootstrap response", async () => {
  for (const value of [{}, { token: "bad", expiresAt: 200000 }, { token: "A".repeat(43), expiresAt: 0 }]) {
    let requests = 0;
    const client = createCompanionClient({ origin: ORIGIN, now: () => 100000, fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => value };
    } });
    await assert.rejects(client("/api/dashboard"), /Invalid companion session/);
    assert.equal(requests, 1);
  }
});

test("all guarded header duplicates fail before bootstrap, preflight, reads or writes", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  const headers = { host: "127.0.0.1:4128", ...browserHeaders(token),
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization, content-type, x-prioritizer-request" };
  for (const name of Object.keys(headers)) {
    // Model Node's parsed single value plus both original raw header lines,
    // including a differently cased duplicate that otherwise looks valid.
    const rawHeaders = [...Object.entries(headers).flat(), name.toUpperCase(), headers[name]];
    for (const path of ["/api/session", "/api/dashboard", ...MUTATIONS]) {
      const response = await request(f, { path, method: path === "/api/dashboard" ? "GET" : "POST", headers, rawHeaders });
      assert.equal(response.status, 403, `${name} on ${path}`);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    const preflight = await request(f, { path: MUTATIONS[0], method: "OPTIONS", headers, rawHeaders });
    assert.equal(preflight.status, 403, `${name} on preflight`);
  }
  assert.deepEqual(f.calls, []);
});

test("unexpected operation errors return a generic non-cacheable response without details or token", async () => {
  let token;
  let attempts = 0;
  const fail = async () => {
    attempts++;
    throw new Error(`SYNTHETIC_PRIVATE_DETAIL ${token}`);
  };
  const f = fixture({ handlerOverrides: { dashboard: fail, createIssue: fail, updatePriority: fail, markDone: fail } });
  ({ token } = await bootstrap(f));
  for (const path of ["/api/dashboard", ...MUTATIONS]) {
    const response = await request(f, { path, method: path === "/api/dashboard" ? "GET" : "POST", headers: browserHeaders(token) });
    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), { error: "Companion request failed" });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.includes("SYNTHETIC_PRIVATE_DETAIL"), false);
    assert.equal(response.body.includes(token), false);
  }
  assert.equal(attempts, 4);
  assert.deepEqual(f.calls, []);
});

test("mutation identifiers are required and validated before body reads or dispatch", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  let bodyReads = 0;
  for (const path of MUTATIONS) {
    for (const id of [undefined, "", "a".repeat(31), "a".repeat(33), "G".repeat(32),
      "A".repeat(32), "a".repeat(32) + "," + "b".repeat(32), ["a".repeat(32)], 123]) {
      const response = await request(f, { path: `${path}?mutationId=${"a".repeat(32)}`, method: "POST",
        headers: { ...browserHeaders(token), "x-prioritizer-mutation": id, cookie: `mutationId=${"a".repeat(32)}` },
        body: "{}", onBodyRead: () => { bodyReads++; } });
      assert.equal(response.status, 400);
    }
    const deniedPreflight = await request(f, { path, method: "OPTIONS", headers: {
      origin: ORIGIN, "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type, x-prioritizer-request",
    } });
    assert.equal(deniedPreflight.status, 403);
  }
  assert.equal(bodyReads, 0);
  assert.deepEqual(f.calls, []);
});

test("simultaneous and later duplicate deliveries run each operation once; first body owns the ID", async () => {
  for (const path of MUTATIONS) {
    let invocations = 0;
    let bodyReads = 0;
    let release;
    let started;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { started = resolve; });
    const operation = async (req) => {
      invocations++;
      let body = "";
      for await (const chunk of req) body += chunk;
      started();
      await gate;
      return { ok: true, originalBody: body };
    };
    const f = fixture({ handlerOverrides: Object.fromEntries(
      ["createIssue", "updatePriority", "markDone"].map((name) => [name, operation])) });
    const { token } = await bootstrap(f);
    const headers = browserHeaders(token);
    const deliver = (body, suffix = "") => request(f, { path: path + suffix, method: "POST", headers, body,
      onBodyRead: () => { bodyReads++; } });
    const first = deliver("first body");
    const concurrent = deliver("different concurrent body");
    await entered;
    assert.equal(invocations, 1);
    assert.equal(bodyReads, 1);
    release();
    const [a, b] = await Promise.all([first, concurrent]);
    const later = await deliver("different later body", "?ignored=changed");
    assert.equal(a.status, path === MUTATIONS[0] ? 201 : 200);
    assert.equal(b.status, a.status);
    assert.equal(later.status, a.status);
    assert.equal(b.body, a.body);
    assert.equal(later.body, a.body);
    assert.equal(JSON.parse(a.body).originalBody, "first body");
    assert.equal(invocations, 1);
    assert.equal(bodyReads, 1);
  }
});

test("retained outcomes are isolated by session and route and never bypass origin or expiry checks", async () => {
  const f = fixture();
  const first = await bootstrap(f);
  const second = await bootstrap(f);
  const id = "a".repeat(32);
  const write = (token, path, changes = {}, target = f) => request(target, { path, method: "POST",
    headers: { ...browserHeaders(token), "x-prioritizer-mutation": id, ...changes } });
  for (const path of MUTATIONS) {
    const a = await write(first.token, path);
    const b = await write(second.token, path);
    assert.equal(a.status, path === MUTATIONS[0] ? 201 : 200);
    assert.equal(b.status, a.status);
    assert.equal((await write(first.token, path)).body, a.body);
  }
  assert.equal(f.calls.length, MUTATIONS.length * 2);
  assert.equal(new Set(f.calls).size, MUTATIONS.length);
  assert.equal((await write(first.token, MUTATIONS[0], { origin: "https://unrelated.example" })).status, 403);
  assert.equal((await write(first.token, MUTATIONS[0], { origin: "http://localhost:4128", host: "localhost:4128" })).status, 401);
  assert.equal((await write(first.token, "/api/not-a-mutation")).status, 404);
  const alias = await bootstrap(f, { origin: "http://localhost:4128", host: "localhost:4128" });
  assert.equal((await write(alias.token, MUTATIONS[0], { origin: "http://localhost:4128", host: "localhost:4128" })).status, 201);
  const restart = fixture();
  assert.equal((await write(first.token, MUTATIONS[0], {}, restart)).status, 401);
  assert.deepEqual(restart.calls, []);
  f.advance(8 * 60 * 60 * 1000);
  assert.equal((await write(first.token, MUTATIONS[0])).status, 401);
  assert.equal(f.calls.length, MUTATIONS.length * 2 + 1);
});

test("a failed response write cannot change or discard the immutable retained result", async () => {
  let invocations = 0;
  const result = { ok: true, issue: { id: "first" } };
  const f = fixture({ handlerOverrides: { createIssue: async () => { invocations++; return result; } } });
  const { token } = await bootstrap(f);
  const options = { path: MUTATIONS[0], method: "POST", headers: browserHeaders(token) };
  let failedWrites = 0;
  await request(f, { ...options, onResponseEnd: (body) => {
    if (body) { failedWrites++; throw new Error("Synthetic closed response"); }
  } });
  result.issue.id = "changed after first delivery";
  const duplicate = await request(f, options);
  assert.equal(failedWrites, 1);
  assert.equal(invocations, 1);
  assert.equal(duplicate.status, 201);
  assert.equal(duplicate.body, '{"ok":true,"issue":{"id":"first"}}');
});

test("handler, serialization and oversized-result failures retain a generic outcome without reexecution", async () => {
  const circular = { ok: true };
  circular.self = circular;
  const cases = [
    () => { throw new Error("SYNTHETIC_PRIVATE_DETAIL"); },
    () => circular,
    () => ({ ok: true, get secret() { throw new Error("SYNTHETIC_PRIVATE_DETAIL"); } }),
    () => ({ ok: true, secret: "SYNTHETIC_PRIVATE_DETAIL".repeat(5000) }),
    () => null,
  ];
  for (const operation of cases) {
    let invocations = 0;
    const f = fixture({ handlerOverrides: { createIssue: async () => { invocations++; return operation(); } } });
    const { token } = await bootstrap(f);
    const options = { path: MUTATIONS[0], method: "POST", headers: browserHeaders(token) };
    for (let delivery = 0; delivery < 2; delivery++) {
      const response = await request(f, options);
      assert.equal(response.status, 500);
      assert.equal(response.body, '{"error":"Companion request failed"}');
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal(invocations, 1);
  }
});

test("expected handler refusals are retained without reexecution", async () => {
  let invocations = 0;
  const f = fixture({ handlerOverrides: { createIssue: async () => {
    invocations++;
    return { ok: false, error: "Synthetic validation refusal" };
  } } });
  const { token } = await bootstrap(f);
  const options = { path: MUTATIONS[0], method: "POST", headers: browserHeaders(token) };
  const first = await request(f, options);
  const repeated = await request(f, options);
  assert.equal(first.status, 400);
  assert.equal(repeated.body, first.body);
  assert.equal(repeated.status, 400);
  assert.equal(invocations, 1);
});

test("entry capacity rejects new IDs before dispatch while retaining every accepted ID", async () => {
  const f = fixture();
  const { token } = await bootstrap(f);
  let oldest;
  for (let i = 0; i < 256; i++) {
    const headers = browserHeaders(token);
    if (i === 0) oldest = headers;
    assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers })).status, 201);
  }
  assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers: browserHeaders(token) })).status, 503);
  assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers: oldest })).status, 201);
  assert.equal(f.calls.length, 256);
  const otherSession = await bootstrap(f);
  assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers: {
    ...oldest, authorization: `Bearer ${otherSession.token}`,
  } })).status, 201);
  assert.equal(f.calls.length, 257);
});

test("result capacity reserves pending operations and does not evict completed outcomes", async () => {
  let invocations = 0;
  let release;
  let allStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { allStarted = resolve; });
  const f = fixture({ handlerOverrides: { createIssue: async () => {
    invocations++;
    if (invocations === 16) allStarted();
    await gate;
    return { ok: true, payload: "s".repeat(60 * 1024) };
  } } });
  const { token } = await bootstrap(f);
  const headers = Array.from({ length: 16 }, () => browserHeaders(token));
  const pending = headers.map((h) => request(f, { path: MUTATIONS[0], method: "POST", headers: h }));
  await entered;
  assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers: browserHeaders(token) })).status, 503);
  const duplicate = request(f, { path: MUTATIONS[0], method: "POST", headers: headers[0] });
  assert.equal(invocations, 16);
  release();
  const completed = await Promise.all(pending);
  assert.ok(completed.every((response) => response.status === 201));
  assert.equal((await duplicate).body, completed[0].body);
  // The retained 16 large outcomes leave less than one full result reservation.
  assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers: browserHeaders(token) })).status, 503);
  assert.equal((await request(f, { path: MUTATIONS[0], method: "POST", headers: headers[15] })).body, completed[15].body);
  assert.equal(invocations, 16);
});

test("client generates one stable transport ID per explicit action and fresh IDs for subsequent actions", async () => {
  const f = fixture();
  const { client, requests } = clientFixture(f, { deliverMutationTwice: true });
  for (const path of MUTATIONS) {
    for (let action = 0; action < 2; action++) {
      const response = await client(path, { method: "POST", headers: {
        "Content-Type": "application/json", "X-Prioritizer-Mutation": "a".repeat(32),
      }, body: "{}" });
      assert.equal(response.status, path === MUTATIONS[0] ? 201 : 200);
    }
  }
  const writes = requests.filter(({ url }) => MUTATIONS.includes(new URL(url).pathname));
  const ids = writes.map(({ options }) => options.headers.get("x-prioritizer-mutation"));
  assert.equal(writes.length, MUTATIONS.length * 2); // one fetchImpl call per explicit action
  assert.equal(f.calls.length, writes.length); // despite two deliveries per fetchImpl call
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) { assert.match(id, /^[a-f0-9]{32}$/); assert.notEqual(id, "a".repeat(32)); }
  await client("/api/dashboard", { headers: { "X-Prioritizer-Mutation": "a".repeat(32) } });
  assert.equal(requests.at(-1).options.headers.has("x-prioritizer-mutation"), false);
});
