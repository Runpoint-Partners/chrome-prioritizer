import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeWindows,
} from "../lib/schedule.js";

const blockEnabled = document.querySelector("#blockEnabled");
const companionUrl = document.querySelector("#companionUrl");
const windowsList = document.querySelector("#windowsList");
const addWindowButton = document.querySelector("#addWindowButton");
const resetButton = document.querySelector("#resetButton");
const saveButton = document.querySelector("#saveButton");
const saveStatus = document.querySelector("#saveStatus");

let settings = DEFAULT_SETTINGS;

void init();

async function init() {
  settings = await readSettings();
  render();

  addWindowButton.addEventListener("click", () => {
    settings.commsWindows.push({
      id: `window-${Date.now()}`,
      label: "New window",
      start: "09:00",
      end: "09:15",
    });
    render();
  });

  resetButton.addEventListener("click", async () => {
    settings = mergeSettings();
    await writeSettings(settings);
    render();
    flash("Reset.");
  });

  saveButton.addEventListener("click", async () => {
    settings = collectSettings();
    await writeSettings(settings);
    render();
    flash("Saved.");
  });
}

function render() {
  blockEnabled.checked = Boolean(settings.blockEnabled);
  companionUrl.value = settings.companionUrl;
  windowsList.replaceChildren(
    ...settings.commsWindows.map((window, index) => renderWindowRow(window, index)),
  );
}

function renderWindowRow(window, index) {
  const row = document.createElement("div");
  row.className = "window-row";
  row.dataset.index = String(index);

  const label = input("input", window.label, "text");
  label.dataset.field = "label";

  const start = input("time-input", window.start, "time");
  start.dataset.field = "start";

  const end = input("time-input", window.end, "time");
  end.dataset.field = "end";

  const remove = document.createElement("button");
  remove.className = "small-button";
  remove.type = "button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    settings.commsWindows.splice(index, 1);
    render();
  });

  row.append(label, start, end, remove);
  return row;
}

function collectSettings() {
  const commsWindows = [...windowsList.querySelectorAll(".window-row")].map((row) => {
    const fields = Object.fromEntries(
      [...row.querySelectorAll("input")].map((node) => [node.dataset.field, node.value]),
    );
    return {
      id: `window-${row.dataset.index}`,
      label: fields.label,
      start: fields.start,
      end: fields.end,
    };
  });

  return mergeSettings({
    ...settings,
    blockEnabled: blockEnabled.checked,
    companionUrl: companionUrl.value.trim() || DEFAULT_SETTINGS.companionUrl,
    commsWindows: normalizeWindows(commsWindows),
  });
}

function input(className, value, type) {
  const node = document.createElement("input");
  node.className = className;
  node.value = value;
  node.type = type;
  return node;
}

async function readSettings() {
  if (globalThis.chrome?.storage?.sync) {
    const { settings: stored } = await chrome.storage.sync.get("settings");
    return mergeSettings(stored);
  }
  return mergeSettings(JSON.parse(localStorage.getItem("settings") || "{}"));
}

async function writeSettings(nextSettings) {
  if (globalThis.chrome?.storage?.sync) {
    await chrome.storage.sync.set({ settings: nextSettings });
    return;
  }
  localStorage.setItem("settings", JSON.stringify(nextSettings));
}

function flash(message) {
  saveStatus.textContent = message;
  setTimeout(() => {
    saveStatus.textContent = "";
  }, 1800);
}
