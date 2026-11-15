const output = document.querySelector("#result");
const frames = document.querySelector("#frames");
const writes = ["/api/linear/issues", "/api/linear/issues/priority", "/api/linear/issues/done"];
const config = await fetch("/config", { mode: "same-origin", credentials: "omit", redirect: "error" }).then((response) => response.json());
const target = new URL(config.origin);
// The local launcher supplies both origins; reject unexpected destinations.
if (target.protocol !== "http:" || target.hostname !== location.hostname || target.origin === location.origin
  || !["127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("Invalid synthetic target");

function bind(id, action) {
  document.querySelector(`#${id}`).addEventListener("click", async () => {
    try { output.textContent = JSON.stringify(await action(), null, 2); }
    catch (error) { output.textContent = `${error.name}: ${error.message}`; }
  });
}
async function attempt(path, options = {}) {
  try {
    const response = await fetch(new URL(path, target), { redirect: "error", ...options, credentials: "omit" });
    // Never read the response body if a browser unexpectedly permits this read.
    return { path, status: response.status, responseType: response.type };
  } catch (error) { return { path, rejected: error.name }; }
}
const headers = { "Content-Type": "application/json", "X-Prioritizer-Request": "dashboard" };
bind("read", () => attempt("/api/dashboard"));
bind("bootstrap", () => attempt("/api/session", { method: "POST", headers, body: "{}" }));
bind("preflight", () => Promise.all(writes.map((path) => attempt(path, {
  method: "POST", headers: { ...headers, Authorization: "Bearer synthetic-invalid" }, body: "{}",
}))));
bind("simple", () => Promise.all(writes.map((path) => attempt(path, {
  // no-cors requires follow; these three fixed synthetic endpoints do not redirect.
  method: "POST", mode: "no-cors", redirect: "follow", headers: { "Content-Type": "text/plain" }, body: '{"title":"Synthetic forbidden write"}',
}))));
bind("forms", () => {
  frames.replaceChildren();
  for (const [index, path] of writes.entries()) {
    const frame = document.createElement("iframe");
    frame.name = `synthetic-form-${index}`;
    frame.title = `Rejected synthetic form ${index + 1}`;
    const form = document.createElement("form");
    form.method = "POST";
    form.action = new URL(path, target).href;
    form.target = frame.name;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "title";
    input.value = "Synthetic forbidden form";
    form.append(input);
    frames.append(frame, form);
    form.submit();
  }
  return "Forms submitted to fixture only; inspect Network and trusted operation counts.";
});
bind("frame", () => {
  frames.replaceChildren();
  const frame = document.createElement("iframe");
  frame.src = new URL("/pages/dashboard.html", target).href;
  frame.title = "Dashboard should be blocked by frame-ancestors";
  frames.append(frame);
  return "Frame requested; inspect CSP refusal and unchanged operation counts.";
});
