import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  findBlockedSite,
  getBlockDecision,
  getCommsState,
  mergeSettings,
} from "../extension/lib/schedule.js";

const mondayNine = new Date("2026-06-29T09:00:00-05:00");
const morningWindow = new Date("2026-06-29T08:20:00-05:00");

assert.equal(
  getBlockDecision("https://mail.google.com/mail/u/0/#inbox", DEFAULT_SETTINGS, mondayNine).blocked,
  true,
);

assert.equal(
  getBlockDecision("https://mail.google.com/mail/u/0/#inbox", DEFAULT_SETTINGS, morningWindow).blocked,
  false,
);

assert.equal(
  findBlockedSite("https://app.slack.com/client/T123", DEFAULT_SETTINGS)?.id,
  "slack",
);

assert.equal(
  findBlockedSite("https://mobile.twitter.com/home", DEFAULT_SETTINGS)?.id,
  "twitter",
);

assert.equal(
  getBlockDecision("https://example.com", DEFAULT_SETTINGS, mondayNine).blocked,
  false,
);

assert.equal(
  getBlockDecision(
    "https://x.com/home",
    mergeSettings({ blockEnabled: false }),
    mondayNine,
  ).blocked,
  false,
);

assert.equal(getCommsState(DEFAULT_SETTINGS, mondayNine).when, "Opens 12:00 PM");

console.log("schedule tests passed");
