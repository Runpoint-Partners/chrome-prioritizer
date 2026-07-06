export const DEFAULT_SETTINGS = {
  blockEnabled: true,
  companionUrl: "http://127.0.0.1:4128",
  blockedSites: [
    {
      id: "twitter",
      label: "X / Twitter",
      hosts: ["twitter.com", "x.com"],
      includeSubdomains: true,
    },
    {
      id: "gmail",
      label: "Gmail",
      hosts: ["mail.google.com"],
    },
    {
      id: "slack",
      label: "Slack",
      hosts: ["slack.com"],
      includeSubdomains: true,
    },
  ],
  commsWindows: [
    { id: "morning", label: "Morning check", start: "08:00", end: "08:30" },
    { id: "midday", label: "Noon check", start: "12:00", end: "12:30" },
    { id: "afternoon", label: "Afternoon check", start: "15:30", end: "15:45" },
    { id: "wrap", label: "Wrap-up", start: "17:00", end: "17:30" },
  ],
};

export function mergeSettings(value = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    blockedSites: Array.isArray(value.blockedSites)
      ? value.blockedSites
      : DEFAULT_SETTINGS.blockedSites,
    commsWindows: normalizeWindows(
      Array.isArray(value.commsWindows)
        ? value.commsWindows
        : DEFAULT_SETTINGS.commsWindows,
    ),
  };
}

export function normalizeWindows(windows) {
  return windows
    .map((window, index) => ({
      id: window.id || `window-${index + 1}`,
      label: window.label || `Window ${index + 1}`,
      start: normalizeTime(window.start),
      end: normalizeTime(window.end),
    }))
    .filter((window) => window.start && window.end)
    .sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));
}

export function normalizeTime(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseTimeToMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function getMinutesForDate(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

export function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function findBlockedSite(url, settings = DEFAULT_SETTINGS) {
  const hostname = getHostname(url);
  if (!hostname) return null;

  return settings.blockedSites.find((site) =>
    site.hosts.some((host) => {
      if (hostname === host) return true;
      return site.includeSubdomains && hostname.endsWith(`.${host}`);
    }),
  ) || null;
}

export function isWithinWindow(window, minutes) {
  const start = parseTimeToMinutes(window.start);
  const end = parseTimeToMinutes(window.end);
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

export function getCommsState(settings = DEFAULT_SETTINGS, date = new Date()) {
  const normalized = mergeSettings(settings);
  const minutes = getMinutesForDate(date);
  const activeWindow = normalized.commsWindows.find((window) =>
    isWithinWindow(window, minutes),
  );

  if (activeWindow) {
    return {
      open: true,
      activeWindow,
      label: "open",
      boundaryMinutes: parseTimeToMinutes(activeWindow.end),
      when: `Until ${formatMinutes(parseTimeToMinutes(activeWindow.end))}`,
      nextWindow: null,
    };
  }

  const nextWindow = getNextWindow(normalized.commsWindows, minutes);
  return {
    open: false,
    activeWindow: null,
    label: "blocked",
    boundaryMinutes: nextWindow.startMinutes,
    when: `Opens ${formatMinutes(nextWindow.startMinutes)}`,
    nextWindow: nextWindow.window,
  };
}

export function getNextWindow(windows, minutes) {
  for (const window of windows) {
    const startMinutes = parseTimeToMinutes(window.start);
    if (startMinutes > minutes) {
      return { window, startMinutes, daysAway: 0 };
    }
  }

  const first = windows[0];
  return {
    window: first,
    startMinutes: parseTimeToMinutes(first.start),
    daysAway: 1,
  };
}

export function getBlockDecision(url, settings = DEFAULT_SETTINGS, date = new Date()) {
  const normalized = mergeSettings(settings);
  const site = findBlockedSite(url, normalized);
  const comms = getCommsState(normalized, date);

  return {
    blocked: Boolean(normalized.blockEnabled && site && !comms.open),
    site,
    comms,
  };
}

export function formatMinutes(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function formatRange(start, end) {
  return `${formatMinutes(parseTimeToMinutes(start))} - ${formatMinutes(parseTimeToMinutes(end))}`;
}
