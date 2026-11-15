import http from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCompanionHandler } from "./http-boundary.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXTENSION_ROOT = join(PROJECT_ROOT, "extension");
const PORT = Number(process.env.PORT || 4128);
const HOST = process.env.HOST || "127.0.0.1";
// Defaults to the machine's own local time zone. Override with PRIORITIZER_TIME_ZONE
// (an IANA zone name, e.g. "America/Chicago") if the companion runs somewhere else.
const TIME_ZONE = process.env.PRIORITIZER_TIME_ZONE
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";
const LLM_MODEL = process.env.PRIORITIZER_LLM_MODEL || "gpt-5.5";
const MAX_GMAIL_MESSAGES = Number(process.env.PRIORITIZER_GMAIL_MAX || 32);
const MAX_EMAIL_EXCERPT_CHARS = 1800;
const MAX_EMAIL_INPUT_CHARS = 45000;
const CACHE_ROOT = process.env.PRIORITIZER_CACHE_DIR
  || join(homedir(), ".cache", "chrome-prioritizer");
const GMAIL_SUGGESTION_CACHE_VERSION = 2;
// Set PRIORITIZER_CALENDAR_IDS to a comma-separated list of Google Calendar ids
// (e.g. "primary,you@example.com") to pull events from more than your primary calendar.
const CALENDAR_IDS = (process.env.PRIORITIZER_CALENDAR_IDS || "primary")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
// Set PRIORITIZER_OWNER_NAME to personalize the Gmail-suggestion prompt (used only in
// the text sent to the LLM, not stored or transmitted anywhere else).
const OWNER_NAME = process.env.PRIORITIZER_OWNER_NAME || "the user";
// Leave PRIORITIZER_LINEAR_PROJECT_TEAM_KEY unset to show projects from every team;
// set it to a Linear team key (e.g. "ENG") to only surface that team's projects.
const LINEAR_PROJECT_TEAM_KEY = process.env.PRIORITIZER_LINEAR_PROJECT_TEAM_KEY || "";
const FALLBACK_CALENDAR_COLORS = [
  "#ffad46",
  "#63da38",
  "#8e63ce",
  "#42d692",
];
const gmailSuggestionWarmups = new Map();

const LINEAR_QUERY = `query {
  viewer {
    id
    name
  }
  teams(first: 50) {
    nodes {
      id
      key
      name
    }
  }
  projects(first: 100) {
    nodes {
      id
      name
      url
      teams(first: 10) {
        nodes {
          id
          key
          name
        }
      }
    }
  }
  issues(
    filter: {
      assignee: { isMe: { eq: true } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
    first: 100
  ) {
    nodes {
      id
      identifier
      title
      priority
      priorityLabel
      url
      updatedAt
      project { id name url }
      team { id key name }
      state { name type }
    }
  }
}`;

const LINEAR_CREATE_MUTATION = `mutation CreatePriorityIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      id
      identifier
      title
      priority
      priorityLabel
      url
      updatedAt
      project { id name url }
      team { id key name }
      state { name type }
    }
  }
}`;

const LINEAR_UPDATE_PRIORITY_MUTATION = `mutation UpdateIssuePriority($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      priority
      priorityLabel
      url
      updatedAt
      project { id name url }
      team { id key name }
      state { name type }
    }
  }
}`;

const LINEAR_ISSUE_DONE_CONTEXT_QUERY = `query IssueDoneContext($id: String!) {
  issue(id: $id) {
    id
    identifier
    team {
      states(first: 50) {
        nodes {
          id
          name
          type
          position
        }
      }
    }
  }
}`;

const LINEAR_MARK_DONE_MUTATION = `mutation MarkIssueDone($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      id
      identifier
      title
      priority
      priorityLabel
      url
      updatedAt
      project { id name url }
      team { id key name }
      state { name type }
    }
  }
}`;

http
  .createServer(createCompanionHandler({
    host: HOST,
    port: PORT,
    handlers: {
      dashboard: (requestUrl) => {
        const dateKey = parseDashboardDateKey(requestUrl.searchParams.get("date"))
          || localDateKey(new Date());
        return buildDashboardPayload(dateKey);
      },
      createIssue: createLinearIssueFromRequest,
      updatePriority: updateLinearIssuePriorityFromRequest,
      markDone: markLinearIssueDoneFromRequest,
      serveStatic: serveStaticAsset,
    },
  }))
  .listen(PORT, HOST, () => {
    console.log(`Chrome Prioritizer companion listening on http://${HOST === "::1" ? "[::1]" : HOST}:${PORT}`);
    warmGmailSuggestions(tomorrowDateKey());
  });

async function buildDashboardPayload(dateKey) {
  const gmailLoader = dateKey === localDateKey(new Date())
    ? getGmailSuggestions(dateKey)
    : getCachedGmailSuggestionsOrWarm(dateKey);
  const [linearResult, calendarResult, gmailResult] = await Promise.all([
    getLinearPriorities(),
    getCalendarEvents(dateKey),
    gmailLoader,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    date: dateKey,
    sources: {
      linear: sourceMeta(linearResult),
      calendar: sourceMeta(calendarResult),
      gmail: sourceMeta(gmailResult),
    },
    linear: linearResult.items || [],
    linearTeams: linearResult.teams || [],
    linearProjects: linearResult.projects || [],
    linearViewer: linearResult.viewer || null,
    calendarEvents: calendarResult.items || [],
    suggestions: gmailResult.items || [],
  };
}

async function getLinearPriorities() {
  const result = await runJson("linear-gql", [LINEAR_QUERY], { timeout: 20000 });
  if (!result.ok) return result;

  const issues = result.data?.issues?.nodes || [];
  const items = issues.map(mapLinearIssue);
  return {
    ok: true,
    viewer: result.data?.viewer || null,
    teams: result.data?.teams?.nodes || [],
    projects: (result.data?.projects?.nodes || [])
      .filter((project) => linearProjectBelongsToTeam(project, LINEAR_PROJECT_TEAM_KEY))
      .map((project) => mapLinearProject(project, items)),
    items,
  };
}

async function createLinearIssueFromRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const title = cleanHeader(body.title || "");
  const teamId = cleanHeader(body.teamId || "");
  const projectId = cleanHeader(body.projectId || "");
  const priority = normalizeLinearPriority(body.priority);

  if (!title) return { ok: false, error: "Title is required" };
  if (!teamId) return { ok: false, error: "Team is required" };

  const viewerResult = await runJson("linear-gql", [
    "query { viewer { id name } }",
  ], { timeout: 20000 });
  if (!viewerResult.ok) return viewerResult;

  const input = {
    title,
    teamId,
    assigneeId: viewerResult.data?.viewer?.id,
    priority,
    description: buildLinearIssueDescription(body),
  };
  if (projectId) input.projectId = projectId;

  const result = await runJson("linear-gql", [LINEAR_CREATE_MUTATION], {
    timeout: 20000,
    env: {
      LINEAR_GQL_VARIABLES: JSON.stringify({ input }),
    },
  });
  if (!result.ok) return result;

  if (!result.data?.issueCreate?.success || !result.data?.issueCreate?.issue) {
    return { ok: false, error: "Linear did not create the issue" };
  }

  const issue = result.data.issueCreate.issue;
  return {
    ok: true,
    issue: mapLinearIssue(issue),
  };
}

async function updateLinearIssuePriorityFromRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const issueId = cleanHeader(body.issueId || "");
  const priority = normalizeLinearPriority(body.priority);
  if (!issueId) return { ok: false, error: "Issue id is required" };

  const result = await runJson("linear-gql", [LINEAR_UPDATE_PRIORITY_MUTATION], {
    timeout: 20000,
    env: {
      LINEAR_GQL_VARIABLES: JSON.stringify({
        id: issueId,
        input: { priority },
      }),
    },
  });
  if (!result.ok) return result;

  if (!result.data?.issueUpdate?.success || !result.data?.issueUpdate?.issue) {
    return { ok: false, error: "Linear did not update the issue" };
  }

  return {
    ok: true,
    issue: mapLinearIssue(result.data.issueUpdate.issue),
  };
}

async function markLinearIssueDoneFromRequest(request) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const issueId = cleanHeader(body.issueId || "");
  if (!issueId) return { ok: false, error: "Issue id is required" };

  const contextResult = await runJson("linear-gql", [LINEAR_ISSUE_DONE_CONTEXT_QUERY], {
    timeout: 20000,
    env: {
      LINEAR_GQL_VARIABLES: JSON.stringify({ id: issueId }),
    },
  });
  if (!contextResult.ok) return contextResult;

  const completedState = chooseCompletedState(
    contextResult.data?.issue?.team?.states?.nodes || [],
  );
  if (!completedState) {
    return { ok: false, error: "No completed Linear workflow state was found for this issue" };
  }

  const result = await runJson("linear-gql", [LINEAR_MARK_DONE_MUTATION], {
    timeout: 20000,
    env: {
      LINEAR_GQL_VARIABLES: JSON.stringify({
        id: issueId,
        input: { stateId: completedState.id },
      }),
    },
  });
  if (!result.ok) return result;

  if (!result.data?.issueUpdate?.success || !result.data?.issueUpdate?.issue) {
    return { ok: false, error: "Linear did not mark the issue done" };
  }

  return {
    ok: true,
    issue: mapLinearIssue(result.data.issueUpdate.issue),
  };
}

async function getCalendarEvents(dateKey) {
  const bounds = dayBounds(dateKey);
  const calendarMeta = await getCalendarMetadata();
  const eventResults = await Promise.all(
    CALENDAR_IDS.map((calendarId) => getCalendarEventsForCalendar(calendarId, bounds, calendarMeta)),
  );
  const failedResult = eventResults.find((result) => !result.ok);
  if (failedResult && eventResults.every((result) => !result.ok)) return failedResult;

  const events = eventResults.flatMap((result) => result.items || []);
  return {
    ok: true,
    items: dedupeCalendarEvents(events)
      .sort((a, b) => a.startMinutes - b.startMinutes || a.title.localeCompare(b.title)),
  };
}

async function getCalendarEventsForCalendar(calendarId, bounds, calendarMeta) {
  const params = {
    calendarId,
    timeMin: bounds.start.toISOString(),
    timeMax: bounds.end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 24,
  };

  const result = await runJson("gws", [
    "calendar",
    "events",
    "list",
    "--params",
    JSON.stringify(params),
  ], { timeout: 20000 });

  if (!result.ok) return result;

  const meta = calendarMeta.get(calendarId)
    || calendarMeta.get(result.data?.summary)
    || fallbackCalendarMeta(calendarId, CALENDAR_IDS.indexOf(calendarId));
  const events = result.data?.items || [];

  return {
    ok: true,
    items: events
      .filter((event) => event.status !== "cancelled")
      .map((event) => ({
        id: `${meta.id}:${event.id}`,
        title: event.summary || "Busy",
        start: event.start?.dateTime || event.start?.date,
        end: event.end?.dateTime || event.end?.date,
        startMinutes: minutesFromEventTime(event.start?.dateTime || event.start?.date),
        endMinutes: minutesFromEventTime(event.end?.dateTime || event.end?.date),
        htmlLink: event.htmlLink,
        calendarId: meta.id,
        calendarName: meta.name,
        calendarColor: meta.color,
      }))
      .filter((event) => Number.isFinite(event.startMinutes)),
  };
}

async function getCalendarMetadata() {
  const result = await runJson("gws", [
    "calendar",
    "calendarList",
    "list",
    "--params",
    JSON.stringify({ minAccessRole: "reader" }),
  ], { timeout: 20000 });

  const calendarMeta = new Map();
  if (!result.ok) {
    CALENDAR_IDS.forEach((calendarId, index) => {
      const meta = fallbackCalendarMeta(calendarId, index);
      calendarMeta.set(calendarId, meta);
    });
    return calendarMeta;
  }

  for (const calendar of result.data?.items || []) {
    const meta = {
      id: calendar.id,
      name: calendar.summaryOverride || calendar.summary || calendar.id,
      color: calendar.backgroundColor || FALLBACK_CALENDAR_COLORS[calendarMeta.size % FALLBACK_CALENDAR_COLORS.length],
    };
    calendarMeta.set(calendar.id, meta);
    if (calendar.primary) calendarMeta.set("primary", meta);
  }

  CALENDAR_IDS.forEach((calendarId, index) => {
    if (!calendarMeta.has(calendarId)) {
      calendarMeta.set(calendarId, fallbackCalendarMeta(calendarId, index));
    }
  });
  return calendarMeta;
}

function fallbackCalendarMeta(calendarId, index) {
  return {
    id: calendarId,
    name: calendarId === "primary" ? "Primary" : calendarId,
    color: FALLBACK_CALENDAR_COLORS[index % FALLBACK_CALENDAR_COLORS.length],
  };
}

function dedupeCalendarEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [
      event.title,
      event.startMinutes,
      event.endMinutes,
      event.calendarId,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getGmailSuggestions(dateKey) {
  const bounds = emailScanBounds(dateKey);
  const cached = await readGmailSuggestionCache(bounds.cacheKey);
  if (cached) return cached;

  if (!process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      error: "OPENAI_API_KEY is not set",
      items: [],
      model: LLM_MODEL,
    };
  }

  const listResult = await runJson("gws", [
    "gmail",
    "users",
    "messages",
    "list",
    "--params",
    JSON.stringify({
      userId: "me",
      q: `after:${formatGmailSearchDate(bounds.start)} before:${formatGmailSearchDate(bounds.end)} -category:promotions -category:social`,
      maxResults: MAX_GMAIL_MESSAGES,
    }),
  ], { timeout: 20000 });

  if (!listResult.ok) return listResult;

  const messages = listResult.data?.messages || [];
  if (messages.length === 0) {
    const result = {
      ok: true,
      items: [],
      model: LLM_MODEL,
      scanned: 0,
      date: bounds.display,
      scanWindow: bounds.label,
      cached: false,
    };
    await writeGmailSuggestionCache(bounds.cacheKey, result);
    return result;
  }

  const emailResults = await Promise.all(
    messages.slice(0, MAX_GMAIL_MESSAGES).map((message) => getGmailEmail(message.id)),
  );
  const emails = emailResults.filter((item) => item.ok).map((item) => item.email);

  if (emails.length === 0) {
    const result = {
      ok: true,
      items: [],
      model: LLM_MODEL,
      scanned: 0,
      date: bounds.display,
      scanWindow: bounds.label,
      cached: false,
    };
    await writeGmailSuggestionCache(bounds.cacheKey, result);
    return result;
  }

  const llmResult = await inferLinearCandidatesFromEmails(emails, bounds);
  if (!llmResult.ok) return llmResult;

  const result = {
    ok: true,
    items: llmResult.items,
    model: LLM_MODEL,
    scanned: emails.length,
    date: bounds.display,
    scanWindow: bounds.label,
    cached: false,
  };
  await writeGmailSuggestionCache(bounds.cacheKey, result);
  return result;
}

async function getCachedGmailSuggestionsOrWarm(dateKey) {
  const bounds = emailScanBounds(dateKey);
  const cached = await readGmailSuggestionCache(bounds.cacheKey);
  if (cached) return cached;

  warmGmailSuggestions(dateKey);
  return {
    ok: true,
    items: [],
    model: LLM_MODEL,
    scanned: 0,
    date: bounds.display,
    scanWindow: bounds.label,
    cached: false,
    pending: true,
  };
}

function warmGmailSuggestions(dateKey) {
  const bounds = emailScanBounds(dateKey);
  if (gmailSuggestionWarmups.has(bounds.cacheKey)) return;

  const warmup = getGmailSuggestions(dateKey)
    .catch((error) => ({
      ok: false,
      error: sanitizeError(error),
      items: [],
    }))
    .finally(() => {
      gmailSuggestionWarmups.delete(bounds.cacheKey);
    });
  gmailSuggestionWarmups.set(bounds.cacheKey, warmup);
}

async function getGmailEmail(id) {
  const result = await runJson("gws", [
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({
      userId: "me",
      id,
      format: "full",
    }),
  ], { timeout: 20000 });

  if (!result.ok) return result;

  const headers = Object.fromEntries(
    (result.data?.payload?.headers || []).map((header) => [
      header.name.toLowerCase(),
      header.value,
    ]),
  );

  return {
    ok: true,
    email: {
      id,
      threadId: result.data?.threadId,
      subject: cleanHeader(headers.subject || "(no subject)"),
      from: compactSender(headers.from || ""),
      date: cleanHeader(headers.date || ""),
      snippet: cleanText(result.data?.snippet || ""),
      bodyExcerpt: extractMessageText(result.data?.payload || "")
        .slice(0, MAX_EMAIL_EXCERPT_CHARS),
    },
  };
}

async function inferLinearCandidatesFromEmails(emails, bounds) {
  const input = buildEmailAnalysisInput(emails, bounds);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      store: false,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: [
                `You turn email evidence into candidate Linear tasks for ${OWNER_NAME}.`,
                "Use only the supplied email excerpts. Do not invent customers, dates, outcomes, or commitments.",
                `Use a high threshold. Include an item only when ${OWNER_NAME} explicitly said they would do it, was directly asked to do it, owns a clear decision or deliverable, or the email identifies an especially important blocker/deadline for their work.`,
                "Exclude vague follow-ups, maybe-useful ideas, FYI/context updates, status-only messages, newsletters, promotions, automated receipts, calendar noise, and work clearly owned by someone else.",
                "Do not output direct email addresses, phone numbers, secret values, long quotes, or sensitive personal details.",
                "Prefer concise imperative task titles that could be pasted into Linear.",
              ].join(" "),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: input,
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "linear_email_candidates",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
              items: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "title",
                    "src",
                    "urgency",
                    "sourceEmailId",
                    "sourceThreadId",
                    "rationale",
                  ],
                  properties: {
                    title: {
                      type: "string",
                      maxLength: 90,
                    },
                    src: {
                      type: "string",
                      maxLength: 70,
                    },
                    urgency: {
                      type: "string",
                      enum: ["high", "medium", "low"],
                    },
                    sourceEmailId: {
                      type: "string",
                      maxLength: 80,
                    },
                    sourceThreadId: {
                      type: "string",
                      maxLength: 80,
                    },
                    rationale: {
                      type: "string",
                      maxLength: 160,
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: sanitizeOpenAIError(response.status, data),
      items: [],
      model: LLM_MODEL,
    };
  }

  const text = getResponseText(data);
  if (!text) {
    return {
      ok: false,
      error: "OpenAI response did not include output text",
      items: [],
      model: LLM_MODEL,
    };
  }

  try {
    const parsed = JSON.parse(text);
    return {
      ok: true,
      items: normalizeLlmSuggestions(parsed.items || []),
    };
  } catch (error) {
    return {
      ok: false,
      error: `OpenAI response was not valid JSON: ${error.message}`,
      items: [],
      model: LLM_MODEL,
    };
  }
}

async function runJson(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: options.timeout || 15000,
      maxBuffer: 3 * 1024 * 1024,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
    });
    return { ok: true, data: JSON.parse(stdout) };
  } catch (error) {
    return {
      ok: false,
      error: sanitizeError(error),
      items: [],
    };
  }
}

function sourceMeta(result) {
  return {
    ok: Boolean(result.ok),
    count: result.items?.length || 0,
    error: result.ok ? null : result.error,
    model: result.model || undefined,
    scanned: result.scanned || undefined,
    date: result.date || undefined,
    scanWindow: result.scanWindow || undefined,
    cached: result.cached || undefined,
    pending: result.pending || undefined,
  };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) {
      throw new Error("Request body is too large");
    }
  }

  if (!body.trim()) return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function normalizeLinearPriority(value) {
  const priority = Number(value);
  if ([0, 1, 2, 3, 4].includes(priority)) return priority;
  return 3;
}

function buildLinearIssueDescription(body) {
  const suggestion = body.suggestion || {};
  if (!body.suggestion && body.projectId) {
    return "Created from the Chrome Prioritizer project task flow.";
  }

  const lines = [
    "Created from the Chrome Prioritizer suggested-items flow.",
    "",
  ];

  if (suggestion.src) lines.push(`Source: ${cleanHeader(suggestion.src)}`);
  if (suggestion.rationale) lines.push(`Rationale: ${cleanHeader(suggestion.rationale)}`);
  if (suggestion.emailId) lines.push(`Gmail message id: ${cleanHeader(suggestion.emailId)}`);
  if (suggestion.threadId) lines.push(`Gmail thread id: ${cleanHeader(suggestion.threadId)}`);

  return lines.join("\n").trim();
}

function mapLinearIssue(issue) {
  return {
    id: issue.identifier,
    linearId: issue.id,
    title: issue.title,
    meta: `${issue.identifier} - ${issue.project?.name || issue.team?.key || "Linear"}`,
    url: issue.url,
    urgency: linearUrgency(issue),
    priority: normalizeLinearPriority(issue.priority),
    priorityLabel: linearPriorityLabel(issue.priority, issue.priorityLabel),
    state: issue.state?.name,
    updatedAt: issue.updatedAt,
    projectId: issue.project?.id,
    projectName: issue.project?.name,
    projectUrl: issue.project?.url,
    teamId: issue.team?.id,
    teamKey: issue.team?.key,
  };
}

function mapLinearProject(project, issues) {
  return {
    id: project.id,
    name: project.name,
    url: project.url,
    teams: (project.teams?.nodes || []).map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
    })),
    issueCount: issues.filter((issue) => issue.projectId === project.id).length,
  };
}

function linearProjectBelongsToTeam(project, teamKey) {
  if (!teamKey) return true;
  return (project.teams?.nodes || []).some((team) => team.key === teamKey);
}

function linearUrgency(issue) {
  if (issue.priority > 0 && issue.priority <= 2) return "high";
  if (issue.priority === 3 || issue.state?.type === "started") return "medium";
  return "low";
}

function linearPriorityLabel(priority, priorityLabel) {
  if (priorityLabel) return priorityLabel;
  return {
    0: "No priority",
    1: "Urgent",
    2: "High",
    3: "Medium",
    4: "Low",
  }[Number(priority)] || "No priority";
}

function chooseCompletedState(states) {
  const completed = states
    .filter((state) => state?.type === "completed")
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  return completed.find((state) => /^done$/i.test(state.name || ""))
    || completed.find((state) => /done|complete|completed/i.test(state.name || ""))
    || completed[0]
    || null;
}

function dayBounds(dateKey) {
  const start = dateFromKey(dateKey);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function emailScanBounds(dateKey) {
  const end = dateFromKey(dateKey);
  const start = new Date(end);
  start.setDate(start.getDate() - (end.getDay() === 1 ? 3 : 1));
  const startKey = localDateKey(start);
  const endKey = localDateKey(end);
  const lastIncluded = new Date(end);
  lastIncluded.setDate(lastIncluded.getDate() - 1);
  return {
    start,
    end,
    cacheKey: `${dateKey}-${startKey}-${endKey}`,
    display: `${formatDisplayDate(start)}-${formatDisplayDate(lastIncluded)}`,
    label: `${startKey} through ${localDateKey(lastIncluded)}`,
  };
}

function minutesFromEventTime(value) {
  if (!value) return NaN;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return NaN;
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TIME_ZONE,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

function compactSender(value) {
  return value
    .replace(/<.*?>/g, "")
    .replaceAll('"', "")
    .trim()
    .slice(0, 42);
}

function buildEmailAnalysisInput(emails, bounds) {
  const header = `Analyze these bounded excerpts from ${bounds.label}. Return candidate Linear tasks only when the email implies a high-confidence action ${OWNER_NAME} owns, a decision ${OWNER_NAME} needs to make, a deliverable ${OWNER_NAME} committed to, a direct ask of ${OWNER_NAME}, or an especially important blocker/deadline.\n\n`;
  let body = "";

  for (const email of emails) {
    const entry = JSON.stringify({
      id: email.id,
      threadId: email.threadId,
      from: email.from,
      date: email.date,
      subject: email.subject,
      snippet: email.snippet,
      bodyExcerpt: email.bodyExcerpt,
    });
    if (body.length + entry.length > MAX_EMAIL_INPUT_CHARS) break;
    body += `${entry}\n`;
  }

  return header + body;
}

function normalizeLlmSuggestions(items) {
  return items
    .filter((item) => item?.title && item?.sourceEmailId)
    .map((item, index) => ({
      id: `gmail-${item.sourceEmailId}-${stableHash(item.title || String(index))}`,
      title: item.title,
      src: item.src || "Email",
      urgency: ["high", "medium", "low"].includes(item.urgency)
        ? item.urgency
        : "medium",
      threadId: item.sourceThreadId,
      emailId: item.sourceEmailId,
      rationale: item.rationale,
    }));
}

async function readGmailSuggestionCache(cacheKey) {
  try {
    const raw = await readFile(gmailSuggestionCachePath(cacheKey), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.cacheVersion !== GMAIL_SUGGESTION_CACHE_VERSION) return null;
    return {
      ...parsed.result,
      cached: true,
    };
  } catch {
    return null;
  }
}

async function writeGmailSuggestionCache(cacheKey, result) {
  await mkdir(CACHE_ROOT, { recursive: true });
  const payload = {
    cacheVersion: GMAIL_SUGGESTION_CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    result,
  };
  await writeFile(gmailSuggestionCachePath(cacheKey), JSON.stringify(payload, null, 2));
}

function gmailSuggestionCachePath(cacheKey) {
  return join(CACHE_ROOT, `gmail-suggestions-${cacheKey}.json`);
}

function stableHash(value) {
  let hash = 5381;
  for (const character of String(value)) {
    hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  }
  return (hash >>> 0).toString(36);
}

function getResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;

  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text" && content.text)
    .map((content) => content.text)
    .join("");
}

function extractMessageText(payload) {
  const plainParts = [];
  const htmlParts = [];

  visitPayload(payload, (part) => {
    const mimeType = part.mimeType || "";
    const data = part.body?.data;
    if (!data) return;
    const decoded = decodeBase64Url(data);
    if (mimeType.startsWith("text/plain")) plainParts.push(decoded);
    if (mimeType.startsWith("text/html")) htmlParts.push(stripHtml(decoded));
  });

  return cleanText((plainParts.length ? plainParts : htmlParts).join("\n\n"));
}

function visitPayload(part, visitor) {
  visitor(part);
  for (const child of part.parts || []) {
    visitPayload(child, visitor);
  }
}

function decodeBase64Url(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    .toString("utf8");
}

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanHeader(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function cleanText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
}

function formatGmailSearchDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("/");
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).format(date);
}

function parseDashboardDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = dateFromKey(value);
  if (Number.isNaN(date.getTime())) return null;
  return localDateKey(date) === value ? value : null;
}

function dateFromKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function tomorrowDateKey() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localDateKey(date);
}

function sanitizeOpenAIError(status, data) {
  const message = data?.error?.message || data?.message || "OpenAI request failed";
  return `OpenAI ${status}: ${message}`;
}

function sanitizeError(error) {
  if (error.code === "ENOENT") return `${error.path || "command"} not found`;
  if (error.killed) return "command timed out";
  return error.message || "command failed";
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

async function serveStaticAsset(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" || url.pathname === "/dashboard"
    ? "/pages/dashboard.html"
    : url.pathname;

  const allowed = [
    "/pages/dashboard.html",
    "/pages/dashboard.css",
    "/pages/dashboard.js",
    "/pages/options.html",
    "/pages/options.js",
    "/pages/favicon.svg",
    "/lib/schedule.js",
    "/lib/companion-client.js",
  ];

  if (!allowed.includes(pathname)) return false;

  const filePath = normalize(join(EXTENSION_ROOT, pathname));
  if (!filePath.startsWith(EXTENSION_ROOT)) return false;

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store",
    });
    response.end(body);
    return true;
  } catch {
    sendJson(response, 404, { error: "Not found" });
    return true;
  }
}

function contentTypeFor(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
