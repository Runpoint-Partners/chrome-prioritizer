let lastCheckedUrl = "";

void checkCurrentPage();

window.addEventListener("focus", () => {
  void checkCurrentPage();
});

window.addEventListener("pageshow", () => {
  void checkCurrentPage();
});

setInterval(() => {
  void checkCurrentPage();
}, 15000);

async function checkCurrentPage() {
  if (location.href === lastCheckedUrl) return;
  lastCheckedUrl = location.href;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "PRIORITY_BLOCK_CHECK",
      url: location.href,
    });

    if (response?.blocked && response.redirectUrl && !response.redirected) {
      location.replace(response.redirectUrl);
    }
  } catch {
    // The background worker may be waking up. webNavigation is still the main gate.
  }
}
