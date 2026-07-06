import {
  DEFAULT_SETTINGS,
  getBlockDecision,
  mergeSettings,
} from "./lib/schedule.js";

const DASHBOARD_PATH = "pages/dashboard.html";
const ENFORCE_ALARM = "priority-blocker-enforce";
const BLOCKED_PATTERNS = [
  "*://twitter.com/*",
  "*://*.twitter.com/*",
  "*://x.com/*",
  "*://*.x.com/*",
  "*://mail.google.com/*",
  "*://*.slack.com/*",
];

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get("settings");
  if (!settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
  await chrome.alarms.create(ENFORCE_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ENFORCE_ALARM, { periodInMinutes: 1 });
});

chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    await redirectIfBlocked(details.tabId, details.url);
  },
  {
    url: [
      { hostSuffix: "twitter.com" },
      { hostSuffix: "x.com" },
      { hostEquals: "mail.google.com" },
      { hostSuffix: "slack.com" },
    ],
  },
);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ENFORCE_ALARM) return;
  await enforceOpenTabs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PRIORITY_BLOCK_CHECK") return false;

  getSettings()
    .then((settings) => {
      const decision = getBlockDecision(message.url, settings);
      const redirectUrl = decision.blocked
        ? buildRedirectUrl(message.url, decision.site, settings)
        : null;
      if (redirectUrl && sender.tab?.id >= 0) {
        chrome.tabs.update(sender.tab.id, { url: redirectUrl }).catch(() => {});
      }
      sendResponse({
        ...decision,
        redirected: Boolean(redirectUrl && sender.tab?.id >= 0),
        redirectUrl,
      });
    })
    .catch((error) => {
      sendResponse({ blocked: false, error: error.message });
    });

  return true;
});

async function redirectIfBlocked(tabId, url) {
  if (isExtensionUrl(url)) return;

  const settings = await getSettings();
  const decision = getBlockDecision(url, settings);
  if (!decision.blocked) return;

  await chrome.tabs.update(tabId, {
    url: buildRedirectUrl(url, decision.site, settings),
  });
}

async function enforceOpenTabs() {
  const tabs = await chrome.tabs.query({ url: BLOCKED_PATTERNS });
  await Promise.all(
    tabs.map((tab) => {
      if (!tab.id || !tab.url) return null;
      return redirectIfBlocked(tab.id, tab.url);
    }),
  );
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return mergeSettings(settings);
}

function buildRedirectUrl(originalUrl, site, settings = DEFAULT_SETTINGS) {
  const companionUrl = settings.companionUrl || DEFAULT_SETTINGS.companionUrl;
  const url = new URL(`${companionUrl.replace(/\/$/, "")}/${DASHBOARD_PATH}`);
  url.searchParams.set("blocked", originalUrl);
  if (site?.label) url.searchParams.set("site", site.label);
  return url.toString();
}

function isExtensionUrl(url) {
  return url.startsWith(chrome.runtime.getURL(""));
}
