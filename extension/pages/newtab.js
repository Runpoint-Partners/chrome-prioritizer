import {
  DEFAULT_SETTINGS,
  mergeSettings,
} from "../lib/schedule.js";

const DASHBOARD_PATH = "pages/dashboard.html";

void openDashboard();

async function openDashboard() {
  const settings = await readSettings();
  const url = new URL(`${settings.companionUrl.replace(/\/$/, "")}/${DASHBOARD_PATH}`);
  const link = document.querySelector("#dashboardLink");
  if (link) link.href = url.toString();
  location.replace(url.toString());
}

async function readSettings() {
  if (globalThis.chrome?.storage?.sync) {
    const { settings } = await chrome.storage.sync.get("settings");
    return mergeSettings(settings);
  }
  return DEFAULT_SETTINGS;
}
