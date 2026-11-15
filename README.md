# Chrome Prioritizer

Local Chrome extension that replaces the new tab page with a priority dashboard and blocks X/Twitter, Gmail, and Slack outside appointed communication windows.

## Current Shape

- `extension/` is a Manifest V3 extension.
- `companion/` is a localhost-only Node service that reads Linear, Google Calendar, and Gmail through external CLI tools you provide (see Prerequisites below).
- No Linear or Google secret is bundled into the extension.
- The extension overrides Chrome's new-tab page with a tiny packaged redirector to the companion-hosted dashboard.
- The extension sets Chrome's homepage to the companion-hosted dashboard at `http://127.0.0.1:4128/pages/dashboard.html`.

## Prerequisites

The companion shells out to two CLI tools that are **not included in this repo**. You need each one installed and on your `PATH`, authenticated for your own accounts:

- **`linear-gql`** — takes a GraphQL query string as its first argument and prints the JSON response from Linear's GraphQL API (`https://api.linear.app/graphql`) to stdout. Reads its Linear API key from wherever you configure it (an env file, keychain entry, etc. — the companion never sees or stores the key itself). Pass mutation variables via the `LINEAR_GQL_VARIABLES` env var (JSON string) when the companion invokes it.
- **`gws`** — a Google Workspace CLI supporting `gmail` and `calendar` subcommands shaped like `gws gmail users messages list --params '{...}'` / `gws gmail users messages get --params '{...}'` / `gws calendar events list --params '{...}'` / `gws calendar calendarList list --params '{...}'`, where `--params` is a JSON blob matching the corresponding Google API request shape, and the command prints the JSON response to stdout. Reads its own Google OAuth credentials from wherever you configure it.
- An **`OPENAI_API_KEY`** environment variable, used to call the OpenAI Responses API for Gmail-derived task suggestions. Suggestions are skipped (not required) if this isn't set.

If you don't have equivalents for `linear-gql` and `gws`, the Linear and Gmail/Calendar panels will simply show offline states — the extension's site-blocking behavior works independently of the companion.

## Run It

1. Start the local companion:

   ```bash
   npm run companion
   ```

2. Load the extension:

   - Open `chrome://extensions`
   - Enable Developer Mode
   - Click Load unpacked
   - Select the `extension/` folder in this repo

3. Open a new tab to see the dashboard.

After this redirector version is loaded once, most dashboard UI/function edits only need a page refresh because Chrome is loading `http://127.0.0.1:4128/pages/dashboard.html`. Reload the unpacked extension only for manifest, background worker, content script, options page, or redirector changes.

Default communication windows are:

- 8:00-8:30 AM
- 12:00-12:30 PM
- 3:30-3:45 PM
- 5:00-5:30 PM

Change them from the extension options page.

## Configuration

The companion reads all of these from the environment (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4128` | Port the companion listens on |
| `HOST` | `127.0.0.1` | Loopback bind address: `127.0.0.1` or `::1` only |
| `PRIORITIZER_TIME_ZONE` | machine's local time zone | IANA zone name used to bucket calendar events and email scan windows |
| `PRIORITIZER_LLM_MODEL` | `gpt-5.5` | Model passed to the OpenAI Responses API |
| `PRIORITIZER_GMAIL_MAX` | `32` | Max Gmail messages scanned per day |
| `PRIORITIZER_CACHE_DIR` | `~/.cache/chrome-prioritizer` | Where Gmail-suggestion results are cached |
| `PRIORITIZER_CALENDAR_IDS` | `primary` | Comma-separated Google Calendar ids to pull events from |
| `PRIORITIZER_LINEAR_PROJECT_TEAM_KEY` | unset (all teams) | Restrict the Projects panel to one Linear team key |
| `PRIORITIZER_OWNER_NAME` | `the user` | Personalizes the wording sent to the LLM when scoring Gmail suggestions |

The dashboard fetches `/api/dashboard` from its own companion origin. If the companion is not running, it shows source-specific offline states.

### Companion access

Open the dashboard through the companion. The extension's new-tab, homepage and blocked-site redirects use this route. Direct visits to the packaged extension dashboard also redirect there; no extension origin receives API access. A separate static preview server cannot access the companion API.

The hosted dashboard obtains a random session token through a same-origin JSON POST. Tokens remain in page memory, expire after eight hours and are invalidated when the companion restarts. The server keeps at most 128 sessions. Dashboard reads and Linear writes require the token, the dashboard request header and same-origin Fetch Metadata; POST also requires an exact matching Origin and JSON content type. Missing Origin is accepted only for authenticated same-origin GET fetches. Ordinary CLI API callers are unsupported. These checks protect the browser boundary; they do not isolate a compromised local process or an extension able to impersonate the hosted page.

Host checks accept the configured loopback literal and `localhost` at the configured port. Other origins, including other loopback ports, opaque origins and all extension origins, are rejected. Keep the extension's Companion URL pointed at the running companion when changing its port or bind address. API credentials always stay on the page's own origin. After a restart, refresh again if the dashboard reports an expired session; writes are never replayed automatically.

Each write gets a unique request ID. Repeated delivery of that ID within the same session and route shares one operation and its retained result. Retention is limited to 256 writes and 1 MiB per session, with a 64 KiB limit on each result. A failed response can follow a successful update, so refresh and check the issue before repeating an uncertain write. A new user action gets a new ID; this protection does not persist across companion restarts.

The focused regression suite uses synthetic request handlers and fetch responses. It does not import the executable server or use account CLIs:

```bash
node --test test/companion-security.test.mjs
```

`npm test` runs the schedule and companion security suites. `npm run check` checks the companion, extension and browser-fixture JavaScript syntax.

### Gmail suggestions

Gmail suggestions use the OpenAI Responses API with `gpt-5.5` by default.
The companion scans bounded excerpts from the prior business email window:

- Tuesday-Friday and Sunday: the prior calendar day.
- Monday: Friday, Saturday, and Sunday.

Each local dashboard day is scanned at most once. The resulting suggestions are cached under `~/.cache/chrome-prioritizer/` (or `PRIORITIZER_CACHE_DIR`), so refreshing the dashboard does not re-read Gmail or re-run the model for that day. Override the model with:

```bash
PRIORITIZER_LLM_MODEL=gpt-5.5 npm run companion
```

## Dashboard Behavior

- Communication windows stay manual in the extension options.
- Today's plan starts empty each day, is saved by date, and can be moved forward/backward with the plan arrows. Plan slots are generated from the first four available 45-minute windows between 8 AM and 5 PM, after calendar events and communication windows are treated as unavailable.
- Linear tasks are grouped by Linear priority: Urgent, High, Medium, Low, and No priority.
- Use the priority menu on each Linear row to update the issue priority in Linear.
- Use the check control on a task row or planned slot to mark the Linear issue done. Completed planned slots stay visible for that day with a Done marker, while the issue leaves the Tasks list.
- The bottom of the Tasks column lists your Linear projects (optionally filtered to one team via `PRIORITIZER_LINEAR_PROJECT_TEAM_KEY`), including projects with zero assigned tasks. Projects expand to show open assigned tasks and include an inline creator for a new task in that project.
- Drag Linear tasks into open slots; drag filled slots to move or swap them; clear a slot with `x`.
- Priority rows open their Linear ticket. The `Linear` heading opens your Linear my-issues view.
- Suggested items can be dismissed. The `+` action opens a create-ticket modal where priority and team are chosen before writing to Linear.
- The dashboard does not show seeded priority, calendar, or suggestion data. If a source is offline, it shows an empty/offline state.
- Suggested items use a high threshold: include only explicit commitments you made, direct asks of you, clear decisions/deliverables you own, or especially important blockers/deadlines. Exclude FYI/context, vague follow-ups, newsletters, automated noise, maybe-useful ideas, and work owned by someone else.

---

Built by Sam Gaddis · [Runpoint](https://runpoint.ai). MIT licensed.
