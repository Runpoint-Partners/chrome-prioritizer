// Session credentials stay in this page's memory. Settings, URLs and storage
// cannot redirect authenticated requests to another origin.
export function createCompanionClient({ origin, fetchImpl = globalThis.fetch, now = Date.now }) {
  const base = new URL(origin);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    || base.origin !== origin) {
    throw new Error("Open the dashboard from the loopback companion");
  }
  let session = null;
  let bootstrap = null;

  async function getSession(signal) {
    if (session && session.expiresAt > now() + 5000) return session;
    if (!bootstrap) {
      bootstrap = (async () => {
        const response = await fetchImpl(new URL("/api/session", origin).href, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Prioritizer-Request": "dashboard" },
          body: "{}",
          mode: "same-origin",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "same-origin",
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error(`Companion session returned ${response.status}`);
        const value = await response.json();
        if (!/^[A-Za-z0-9_-]{43}$/.test(value.token || "")
          || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
          throw new Error("Invalid companion session");
        }
        session = value;
        return session;
      })().finally(() => { bootstrap = null; });
    }
    return bootstrap;
  }

  return async function companionFetch(path, options = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")
      || url.pathname === "/api/session" || url.username || url.password || url.hash) {
      throw new Error("Invalid companion request URL");
    }
    const currentSession = await getSession(options.signal);
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${currentSession.token}`);
    headers.set("X-Prioritizer-Request", "dashboard");
    if (String(options.method || "GET").toUpperCase() === "POST") {
      // One ID per explicit call; the browser reuses these same header bytes if
      // its network stack retransmits. Never accept a caller-supplied stale ID.
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      headers.set("X-Prioritizer-Mutation", Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    } else {
      headers.delete("X-Prioritizer-Mutation");
    }
    const response = await fetchImpl(url.href, {
      ...options,
      headers,
      mode: "same-origin",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      if (session === currentSession) session = null;
      // Never replay writes. The next refresh/action establishes a new session.
      throw new Error("Companion session expired; refresh and try again");
    }
    return response;
  };
}
