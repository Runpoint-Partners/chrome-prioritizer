import { createCompanionClient } from "/lib/companion-client.js";

let mutationFetchCalls = 0;
const client = createCompanionClient({ origin: location.origin, fetchImpl: (url, options) => {
  if (options.method === "POST" && new URL(url).pathname !== "/api/session") mutationFetchCalls++;
  return fetch(url, options);
} });
const output = document.querySelector("#result");
const stateOutput = document.querySelector("#state");
const buttons = [...document.querySelectorAll("button")];

async function inspect() {
  const response = await fetch("/fixture/state", {
    headers: { "X-Fixture-Inspect": "1" }, mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store",
  });
  if (!response.ok) throw new Error(`Inspection returned ${response.status}`);
  const state = await response.json();
  stateOutput.textContent = JSON.stringify(state, null, 2);
  document.querySelector("#untrusted").href = `${state.untrustedOrigin}/`;
  return state;
}
function bind(id, operation) {
  document.querySelector(`#${id}`).addEventListener("click", async () => {
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const result = await operation();
      output.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      // Do not display fetch options, session responses or bearer values.
      output.textContent = `${error.name}: ${error.message}`;
    } finally {
      try { await inspect(); } catch { stateOutput.textContent = "Fixture unavailable; restart or stop may have occurred."; }
      buttons.forEach((button) => { button.disabled = false; });
    }
  });
}
async function call(path, options) {
  const response = await client(path, options);
  return { status: response.status, body: await response.json() };
}
const write = (fixtureDisconnect) => call("/api/linear/issues", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Synthetic probe issue", teamId: "fixture-team", priority: 3, fixtureDisconnect }),
});
bind("read", () => call("/api/dashboard"));
bind("write", () => write(false));
bind("disconnect", async () => {
  const before = await inspect();
  const beforeFetchCalls = mutationFetchCalls;
  let outcome;
  try { outcome = await write(true); }
  catch (error) { outcome = { error: error.name }; }
  const after = await inspect();
  return { outcome, mutationFetchCalls: mutationFetchCalls - beforeFetchCalls,
    createHandlerDelta: after.counts.create - before.counts.create,
    issueCountDelta: after.issues.length - before.issues.length,
    expected: "One fetch invocation and one operation; native retry may return the retained result." };
});
bind("sameRedirect", () => call("/api/fixture-redirect?to=same"));
bind("otherRedirect", () => call("/api/fixture-redirect"));
bind("inspect", async () => { await inspect(); return { inspected: true }; });
void inspect().catch(() => { stateOutput.textContent = "Fixture inspection unavailable."; });
