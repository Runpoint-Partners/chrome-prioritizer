import {
  DEFAULT_SETTINGS,
  getBlockDecision,
  getCommsState,
  mergeSettings,
  parseTimeToMinutes,
} from "../lib/schedule.js";
import { createCompanionClient } from "../lib/companion-client.js";

const PLAN_SLOT_MINUTES = 45;
const PLAN_SLOT_COUNT = 4;
const PLAN_DAY_START_MINUTES = 8 * 60;
const PLAN_DAY_END_MINUTES = 17 * 60;
const AGENDA_MIN_ROW_HEIGHT = 28;
const AGENDA_MINUTE_HEIGHT = 0.9;

const LINEAR_PRIORITIES = [
  { value: 1, label: "Urgent", group: "Urgent", urgency: "high" },
  { value: 2, label: "High", group: "High", urgency: "high" },
  { value: 3, label: "Medium", group: "Medium", urgency: "medium" },
  { value: 4, label: "Low", group: "Low", urgency: "low" },
  { value: 0, label: "No priority", group: "No priority", urgency: "low" },
];

const PLAN_SCHEMA_VERSION = 2;
// Fallback only; getLinearMyIssuesUrl() derives the real workspace URL from a live issue's URL.
const LINEAR_MY_ISSUES_URL = "https://linear.app";

// Favicon reflects the current state: sites locked down (default),
// a communication window is open, or a focus session is running.
const FAVICON_MODES = {
  blocked: { color: "#0a0a0a", open: false },
  comms: { color: "#2563eb", open: true },
  focus: { color: "#15803d", open: false },
};
let activeFaviconMode = null;
let pendingGmailRefreshTimer = null;
let companionFetch;
const todayKey = localDateKey(new Date());
const initialParams = new URLSearchParams(location.search);

const elements = {
  activeFocus: document.querySelector("#activeFocus"),
  activeTitle: document.querySelector("#activeTitle"),
  agendaList: document.querySelector("#agendaList"),
  blockedBanner: document.querySelector("#blockedBanner"),
  blockedTitle: document.querySelector("#blockedTitle"),
  commsState: document.querySelector("#commsState"),
  commsWhen: document.querySelector("#commsWhen"),
  dateText: document.querySelector("#dateText"),
  elapsedText: document.querySelector("#elapsedText"),
  focusControl: document.querySelector("#focusControl"),
  focusLabel: document.querySelector("#focusLabel"),
  linearLink: document.querySelector("#linearLink"),
  linearList: document.querySelector("#linearList"),
  favicon: document.querySelector("#favicon"),
  lockIcon: document.querySelector("#lockIcon"),
  openOriginalButton: document.querySelector("#openOriginalButton"),
  nextDayButton: document.querySelector("#nextDayButton"),
  planDateLabel: document.querySelector("#planDateLabel"),
  planTitle: document.querySelector("#planTitle"),
  prevDayButton: document.querySelector("#prevDayButton"),
  refreshButton: document.querySelector("#refreshButton"),
  startFocusButton: document.querySelector("#startFocusButton"),
  startTopButton: document.querySelector("#startTopButton"),
  statusStrip: document.querySelector("#statusStrip"),
  stopFocusButton: document.querySelector("#stopFocusButton"),
  suggestCount: document.querySelector("#suggestCount"),
  suggestionsList: document.querySelector("#suggestionsList"),
  syncStatus: document.querySelector("#syncStatus"),
  ticketCancelButton: document.querySelector("#ticketCancelButton"),
  ticketCloseButton: document.querySelector("#ticketCloseButton"),
  ticketForm: document.querySelector("#ticketForm"),
  ticketModal: document.querySelector("#ticketModal"),
  ticketPriority: document.querySelector("#ticketPriority"),
  ticketStatus: document.querySelector("#ticketStatus"),
  ticketSubmitButton: document.querySelector("#ticketSubmitButton"),
  ticketTeam: document.querySelector("#ticketTeam"),
  ticketTitle: document.querySelector("#ticketTitle"),
  timeText: document.querySelector("#timeText"),
  topTitle: document.querySelector("#topTitle"),
};

const state = {
  active: null,
  blockedUrl: initialParams.get("blocked"),
  blockedSite: initialParams.get("site"),
  createdPriorities: [],
  data: null,
  dismissedSuggestions: new Set(),
  dragPayload: null,
  collapsedProjects: new Set(),
  modalSuggestion: null,
  openPriorityMenu: null,
  openPriorityMenuDirection: "down",
  openPriorityMenuPosition: null,
  plan: createEmptyPlan(todayKey),
  planDate: parseDateKey(initialParams.get("date")) || todayKey,
  activeProjectTaskProjectId: "",
  projectTaskCreating: new Set(),
  projectTaskDrafts: {},
  projectTaskErrors: {},
  doneUpdating: new Set(),
  priorityUpdating: new Set(),
  settings: DEFAULT_SETTINGS,
};

void init();

async function init() {
  state.settings = await readSettings();
  // The extension's new-tab/background flows already open the hosted UI.
  // Keep direct visits to the packaged dashboard on the same secure path.
  if (location.protocol === "chrome-extension:") {
    const url = new URL("/pages/dashboard.html", state.settings.companionUrl);
    url.search = location.search;
    location.replace(url.href);
    return;
  }
  companionFetch = createCompanionClient({ origin: location.origin });
  const [active, plan, dismissedSuggestions] = await Promise.all([
    readActiveFocus(),
    readDailyPlan(state.planDate),
    readDismissedSuggestions(state.planDate),
  ]);
  state.active = active;
  state.plan = plan;
  state.dismissedSuggestions = new Set(dismissedSuggestions);
  state.createdPriorities = [];
  void removeLocalValue(createdPrioritiesKey());

  bindActions();
  render();
  await refreshData();

  setInterval(() => {
    renderTimeSensitiveSections();
  }, 1000);
}

function bindActions() {
  elements.refreshButton?.addEventListener("click", () => {
    void refreshData();
    render();
  });

  elements.openOriginalButton?.addEventListener("click", () => {
    if (state.blockedUrl) {
      location.href = state.blockedUrl;
    }
  });

  elements.startFocusButton?.addEventListener("click", () => {
    startFocus(findCurrentPlannedItem() || getLinearItems()[0]);
  });

  elements.startTopButton?.addEventListener("click", () => {
    startFocus(findCurrentPlannedItem() || getLinearItems()[0]);
  });

  elements.stopFocusButton?.addEventListener("click", () => {
    state.active = null;
    void writeActiveFocus(null);
    render();
  });

  document.addEventListener("click", () => {
    if (!state.openPriorityMenu) return;
    state.openPriorityMenu = null;
    state.openPriorityMenuDirection = "down";
    state.openPriorityMenuPosition = null;
    renderLinear();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.openPriorityMenu) return;
    state.openPriorityMenu = null;
    state.openPriorityMenuDirection = "down";
    state.openPriorityMenuPosition = null;
    renderLinear();
  });

  elements.prevDayButton?.addEventListener("click", () => {
    void changePlanDate(shiftDateKey(state.planDate, -1));
  });

  elements.nextDayButton?.addEventListener("click", () => {
    void changePlanDate(shiftDateKey(state.planDate, 1));
  });

  elements.ticketCancelButton?.addEventListener("click", closeTicketModal);
  elements.ticketCloseButton?.addEventListener("click", closeTicketModal);
  elements.ticketModal?.addEventListener("click", (event) => {
    if (event.target === elements.ticketModal) closeTicketModal();
  });
  elements.ticketForm?.addEventListener("submit", (event) => {
    void createTicketFromModal(event);
  });
}

async function refreshData() {
  const dateKey = state.planDate;
  try {
    const url = new URL("/api/dashboard", location.origin);
    url.searchParams.set("date", dateKey);
    const response = await companionFetch(url.toString(), {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Companion returned ${response.status}`);
    const data = await response.json();
    if (dateKey !== state.planDate) return;
    state.data = data;
    if (elements.syncStatus) {
      elements.syncStatus.textContent = buildSyncStatus(state.data.sources);
    }
    syncPlanSlotsToAvailability();
    schedulePendingGmailRefresh(dateKey);
  } catch (error) {
    state.data = null;
    schedulePendingGmailRefresh(null);
    if (elements.syncStatus) {
      elements.syncStatus.textContent = `Companion disconnected - showing offline states (${error.message})`;
    }
  }
  render();
}

function render() {
  renderTimeSensitiveSections();
  renderBlockedBanner();
  renderLinear();
  renderAgenda();
  renderSuggestions();
}

function faviconDataUri({ color, open }) {
  const shackle = open
    ? "M7.75 10.25V7.5a4.25 4.25 0 0 1 7.1 -3.3"
    : "M7.75 10.25V7.5a4.25 4.25 0 0 1 8.5 0v2.75";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<rect x="4.25" y="10.25" width="15.5" height="11.5" rx="3.2" fill="${color}"/>` +
    `<path d="${shackle}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<circle cx="12" cy="15" r="1.7" fill="#ffffff"/>` +
    `<rect x="11.1" y="15.7" width="1.8" height="3.4" rx="0.9" fill="#ffffff"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function updateFavicon(mode) {
  if (mode === activeFaviconMode) return;
  const config = FAVICON_MODES[mode] || FAVICON_MODES.blocked;
  if (!elements.favicon) return;
  elements.favicon.href = faviconDataUri(config);
  activeFaviconMode = mode;
}

function renderTimeSensitiveSections() {
  const now = new Date();
  elements.timeText.textContent = formatClock(now);
  elements.dateText.textContent = formatDate(now);

  const comms = getCommsState(state.settings, now);
  elements.commsState.textContent = comms.label;
  elements.commsWhen.textContent = comms.when;
  elements.lockIcon.classList.toggle("open", comms.open);
  elements.statusStrip?.classList.toggle("is-open", comms.open);

  updateFavicon(state.active ? "focus" : comms.open ? "comms" : "blocked");

  if (state.active) {
    elements.focusControl.hidden = true;
    elements.activeFocus.hidden = false;
    elements.activeTitle.textContent = state.active.title;
    elements.elapsedText.textContent = formatElapsed(now.getTime() - state.active.startedAt);
  } else {
    elements.focusControl.hidden = false;
    elements.activeFocus.hidden = true;
  }

  renderBlockedBanner();
  renderNowLine();
}

function renderBlockedBanner() {
  if (!elements.blockedBanner) return;
  if (!state.blockedUrl) {
    elements.blockedBanner.hidden = true;
    return;
  }

  const decision = getBlockDecision(state.blockedUrl, state.settings);
  const site = state.blockedSite || decision.site?.label || "that site";
  elements.blockedBanner.hidden = false;
  elements.blockedTitle.textContent = decision.blocked
    ? `${site} is closed. ${decision.comms.when}.`
    : `${site} is inside a communication window.`;
  elements.openOriginalButton.hidden = decision.blocked;
  elements.openOriginalButton.disabled = false;
}

function renderLinear() {
  const items = getLinearItems();
  const allItems = getAllLinearItems();
  const currentItem = findCurrentPlannedItem() || items[0];
  elements.topTitle.textContent = currentItem?.title || "Pick a priority";
  if (elements.linearLink) elements.linearLink.href = getLinearMyIssuesUrl();

  const content = [];
  const projectSummary = renderLinearProjects(allItems);
  if (items.length === 0) {
    content.push(emptyState(
      state.data?.sources?.linear?.ok
        ? "No prioritized tasks"
        : "Linear is offline",
    ));
    if (projectSummary) content.push(projectSummary);
    elements.linearList.replaceChildren(...content);
    return;
  }

  const groups = groupLinearItems(items);
  content.push(
    ...groups.flatMap((group) => {
      const heading = document.createElement("div");
      heading.className = "priority-group-heading";
      heading.append(
        span("", group.label),
        span("priority-group-count", String(group.items.length)),
      );
      return [
        heading,
        ...group.items.map((item) => {
          return renderPriorityRow(item);
        }),
      ];
    }),
  );
  if (projectSummary) content.push(projectSummary);
  elements.linearList.replaceChildren(...content);
}

function renderPriorityRow(item) {
  const row = document.createElement("div");
  row.className = "priority-row";
  const planned = isItemInPlan(item);
  if (planned) row.classList.add("is-planned");
  if (isItemBusy(item)) row.classList.add("is-updating");
  row.draggable = true;
  row.role = "button";
  row.tabIndex = 0;
  row.title = item.url ? "Open in Linear" : "Drag into today's plan";
  row.addEventListener("click", () => openExternalUrl(item.url));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openExternalUrl(item.url);
  });
  row.addEventListener("dragstart", (event) => {
    beginDrag(event, { type: "priority", item: toPlanItem(item) });
  });

  row.append(
    renderDoneButton(item),
    renderPrioritySelect(item, "top"),
    rowCopy(item.title, item.meta, planned ? "In plan" : ""),
  );
  return row;
}

function renderLinearProjects(items) {
  if (!state.data?.sources?.linear?.ok) return null;
  const projects = summarizeLinearProjects(items, state.data.linearProjects || []);
  if (projects.length === 0) return null;

  const section = document.createElement("div");
  section.className = "project-summary";
  const heading = document.createElement("div");
  heading.className = "project-summary-heading";
  const allExpanded = projects.every((project) => !state.collapsedProjects.has(project.id));
  const actions = document.createElement("div");
  actions.className = "project-summary-actions";
  const expandButton = document.createElement("button");
  expandButton.className = "project-expand-all";
  expandButton.type = "button";
  expandButton.textContent = allExpanded ? "Collapse all" : "Expand all";
  expandButton.addEventListener("click", () => toggleAllProjects(projects, !allExpanded));
  actions.append(span("project-summary-count", String(projects.length)), expandButton);
  heading.append(span("", "Projects"), actions);
  section.append(heading);

  section.append(...projects.map((project) => {
    const panel = document.createElement("div");
    panel.className = "project-panel";
    const expanded = !state.collapsedProjects.has(project.id);

    const row = document.createElement("div");
    row.className = "project-row";
    const toggleButton = document.createElement("button");
    toggleButton.className = "project-row-main";
    toggleButton.type = "button";
    toggleButton.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggleButton.addEventListener("click", () => toggleProject(project.id));
    toggleButton.append(
      span("project-toggle", expanded ? "v" : ">"),
      span("project-name", project.name),
    );
    const actions = document.createElement("div");
    actions.className = "project-row-actions";
    const addButton = document.createElement("button");
    addButton.className = "project-add-button";
    addButton.type = "button";
    addButton.textContent = "+";
    addButton.disabled = state.projectTaskCreating.has(project.id);
    addButton.setAttribute("aria-label", `Create task in ${project.name}`);
    addButton.addEventListener("click", () => openProjectTaskForm(project.id));
    actions.append(span("project-issue-count", String(project.count)), addButton);
    row.append(toggleButton, actions);
    panel.append(row);
    if (expanded) panel.append(renderProjectDetails(project));
    return panel;
  }));

  return section;
}

function renderProjectDetails(project) {
  const details = document.createElement("div");
  details.className = "project-details";
  const issues = project.issues || [];
  if (issues.length === 0) {
    details.append(span("project-empty", "No open tasks"));
  } else {
    const list = document.createElement("div");
    list.className = "project-issue-list";
    list.append(...issues.map(renderProjectIssue));
    details.append(list);
  }
  if (state.activeProjectTaskProjectId === project.id) {
    details.append(renderProjectTaskForm(project));
  }
  return details;
}

function renderProjectIssue(item) {
  const issue = document.createElement("div");
  issue.className = "project-issue";
  if (normalizePriority(item.priority) === 0) {
    issue.classList.add("is-unprioritized");
  }
  const openButton = document.createElement("button");
  openButton.className = "project-issue-main";
  openButton.type = "button";
  openButton.addEventListener("click", () => openExternalUrl(item.url));
  const titleLine = document.createElement("div");
  titleLine.className = "project-issue-title-line";
  titleLine.append(span("project-issue-title", item.title));
  if (isItemInPlan(item)) titleLine.append(span("planned-badge", "In plan"));
  openButton.append(titleLine);
  issue.append(renderPrioritySelect(item, `project:${item.projectId || item.projectName || "none"}`), openButton);
  return issue;
}

function renderProjectTaskForm(project) {
  const form = document.createElement("form");
  form.className = "project-task-form";
  const input = document.createElement("input");
  input.className = "project-task-input";
  input.dataset.projectId = project.id;
  input.name = "title";
  input.autocomplete = "off";
  input.placeholder = "New task";
  input.value = state.projectTaskDrafts[project.id] || "";
  input.disabled = state.projectTaskCreating.has(project.id);
  input.addEventListener("input", () => {
    state.projectTaskDrafts[project.id] = input.value;
  });

  const button = document.createElement("button");
  button.className = "project-task-submit";
  button.type = "submit";
  button.textContent = "+";
  button.disabled = state.projectTaskCreating.has(project.id);
  button.setAttribute("aria-label", `Create task in ${project.name}`);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void createProjectTask(project, input.value);
  });

  form.append(input, button);
  const error = state.projectTaskErrors[project.id];
  if (error) form.append(span("project-task-error", error));
  return form;
}

function toggleProject(projectId) {
  if (state.collapsedProjects.has(projectId)) {
    state.collapsedProjects.delete(projectId);
  } else {
    state.collapsedProjects.add(projectId);
    if (state.activeProjectTaskProjectId === projectId) {
      state.activeProjectTaskProjectId = "";
    }
  }
  renderLinear();
}

function openProjectTaskForm(projectId) {
  state.activeProjectTaskProjectId = projectId;
  state.collapsedProjects.delete(projectId);
  state.projectTaskErrors[projectId] = "";
  renderLinear();
  requestAnimationFrame(() => {
    document.querySelector(".project-task-input")?.focus();
  });
}

function toggleAllProjects(projects, expanded) {
  for (const project of projects) {
    if (expanded) {
      state.collapsedProjects.delete(project.id);
    } else {
      state.collapsedProjects.add(project.id);
    }
  }
  if (!expanded) state.activeProjectTaskProjectId = "";
  renderLinear();
}

function renderPrioritySelect(item, context = "default") {
  const picker = document.createElement("div");
  const issueKey = item.linearId || item.id;
  const menuKey = `${context}:${issueKey}`;
  const currentPriority = normalizePriority(item.priority);
  picker.className = "priority-picker";
  if (state.openPriorityMenu === menuKey) picker.classList.add("is-open");

  const trigger = document.createElement("button");
  trigger.className = "priority-trigger";
  trigger.type = "button";
  trigger.disabled = !item.linearId || isItemBusy(item);
  trigger.setAttribute("aria-label", `Change Linear priority for ${item.title}`);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", state.openPriorityMenu === menuKey ? "true" : "false");
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = state.openPriorityMenu !== menuKey;
    const position = getPriorityMenuPosition(trigger);
    state.openPriorityMenu = opening ? menuKey : null;
    state.openPriorityMenuDirection = opening && position.opensUp ? "up" : "down";
    state.openPriorityMenuPosition = opening ? position : null;
    renderLinear();
  });
  trigger.addEventListener("keydown", (event) => {
    event.stopPropagation();
  });

  trigger.append(priorityIcon(currentPriority));

  picker.append(trigger);

  if (state.openPriorityMenu === menuKey) {
    const menu = document.createElement("div");
    menu.className = "priority-menu";
    if (state.openPriorityMenuDirection === "up") menu.classList.add("opens-up");
    positionPriorityMenu(menu);
    menu.role = "menu";
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    menu.replaceChildren(
      ...LINEAR_PRIORITIES.map((priority) => {
        const option = document.createElement("button");
        option.className = "priority-option";
        if (priority.value === currentPriority) option.classList.add("is-selected");
        option.type = "button";
        option.role = "menuitemradio";
        option.setAttribute("aria-label", priority.label);
        option.title = priority.label;
        option.setAttribute("aria-checked", priority.value === currentPriority ? "true" : "false");
        option.append(priorityIcon(priority.value));
        option.addEventListener("click", (event) => {
          event.stopPropagation();
          state.openPriorityMenu = null;
          state.openPriorityMenuDirection = "down";
          state.openPriorityMenuPosition = null;
          if (priority.value === currentPriority) {
            renderLinear();
            return;
          }
          void updateLinearPriority(item, priority.value);
        });
        return option;
      }),
    );
    picker.append(menu);
  }

  return picker;
}

function priorityIcon(priority) {
  const icon = document.createElement("span");
  icon.className = `priority-icon is-${priorityClass(priority)}`;
  icon.setAttribute("aria-hidden", "true");
  icon.replaceChildren(...[1, 2, 3, 4].map((index) => {
    const bar = document.createElement("span");
    bar.className = `priority-icon-bar bar-${index}`;
    return bar;
  }));
  return icon;
}

function renderAgenda() {
  elements.planTitle.textContent = formatPlanTitle(state.planDate);
  elements.planDateLabel.textContent = formatPlanDateLabel(state.planDate);
  const agenda = buildAgenda();
  const planSlots = state.plan.slots;
  const focusCount = planSlots.filter((slot) => slot.item).length;
  elements.focusLabel.textContent = `${focusCount} of ${planSlots.length} slots filled`;
  elements.agendaList.replaceChildren(...agenda.map(renderAgendaItem));
  requestAnimationFrame(() => renderNowLine());
}

function renderAgendaItem(item) {
  const row = document.createElement("div");
  row.className = `agenda-row is-${item.kind}`;
  row.dataset.startMinutes = String(item.startMinutes);
  row.dataset.endMinutes = String(item.endMinutes);
  row.style.minHeight = `${agendaRowHeight(item)}px`;
  if (item.kind === "comms" && isNow(item)) row.classList.add("is-now");
  if (item.kind === "mixed-group" && item.items.some((candidate) => candidate.kind === "comms" && isNow(candidate))) {
    row.classList.add("is-comms", "is-now");
  }
  row.append(renderAgendaTime(item), renderAgendaBody(item));

  const dropSlot = agendaDropSlot(item);
  if (dropSlot) {
    row.addEventListener("dragover", (event) => allowSlotDrop(event, row));
    row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
    row.addEventListener("drop", (event) => {
      void handleSlotDrop(event, dropSlot, row);
    });
  }

  return row;
}

function agendaRowHeight(item) {
  const duration = Math.max(0, item.endMinutes - item.startMinutes);
  return Math.max(AGENDA_MIN_ROW_HEIGHT, Math.round(duration * AGENDA_MINUTE_HEIGHT));
}

function agendaDropSlot(item) {
  if (item.kind === "empty" || (item.kind === "focus" && !item.completedAt)) {
    return {
      id: item.slotId,
      start: minutesToTime(item.startMinutes),
      end: minutesToTime(item.endMinutes),
    };
  }

  if (isCalendarAgendaItem(item) || item.kind === "mixed-group") {
    const focusItem = item.kind === "mixed-group"
      ? item.items.find((candidate) => candidate.kind === "focus")
      : null;
    return {
      id: focusItem?.slotId || slotIdForWindow(item.startMinutes, item.endMinutes),
      start: minutesToTime(item.startMinutes),
      end: minutesToTime(item.endMinutes),
    };
  }

  return null;
}

function renderNowLine() {
  elements.agendaList.querySelector(".now-line")?.remove();
  if (state.planDate !== todayKey) return;

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const rows = [...elements.agendaList.querySelectorAll(".agenda-row")];
  if (rows.length === 0) return;

  const firstStart = Number(rows[0].dataset.startMinutes);
  const lastEnd = Number(rows.at(-1).dataset.endMinutes);
  if (!Number.isFinite(firstStart) || !Number.isFinite(lastEnd)) return;
  if (minutes < firstStart || minutes > lastEnd) return;

  const top = calculateNowLineTop(rows, minutes);
  const line = document.createElement("div");
  line.className = "now-line";
  line.style.top = `${top}px`;
  line.append(span("now-line-time", formatAgendaMinutes(minutes)));
  elements.agendaList.append(line);
}

function calculateNowLineTop(rows, minutes) {
  const listRect = elements.agendaList.getBoundingClientRect();
  let previous = rows[0];
  for (const row of rows) {
    const start = Number(row.dataset.startMinutes);
    const end = Number(row.dataset.endMinutes);
    if (Number.isFinite(start) && Number.isFinite(end) && minutes >= start && minutes <= end) {
      const rect = row.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (minutes - start) / Math.max(1, end - start)));
      return rect.top - listRect.top + rect.height * ratio + elements.agendaList.scrollTop;
    }
    if (Number.isFinite(start) && start > minutes) {
      const previousRect = previous.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const previousStart = Number(previous.dataset.startMinutes);
      const spanMinutes = Math.max(1, start - previousStart);
      const ratio = Math.min(1, Math.max(0, (minutes - previousStart) / spanMinutes));
      return previousRect.top - listRect.top
        + (rowRect.top - previousRect.top) * ratio
        + elements.agendaList.scrollTop;
    }
    previous = row;
  }
  const lastRect = previous.getBoundingClientRect();
  return lastRect.bottom - listRect.top + elements.agendaList.scrollTop;
}

function renderAgendaTime(item) {
  const time = document.createElement("div");
  time.className = "agenda-time";
  time.append(span("", formatAgendaMinutes(item.startMinutes)));
  return time;
}

function renderAgendaBody(item) {
  if (item.kind === "mixed-group") {
    const body = document.createElement("div");
    body.className = "agenda-mixed-group";
    body.style.gridTemplateColumns = `repeat(${item.items.length}, minmax(0, 1fr))`;
    body.replaceChildren(...item.items.map(renderAgendaBody));
    return body;
  }

  if (item.kind === "event") {
    return renderCalendarEvent(item);
  }

  if (item.kind === "event-group") {
    const body = document.createElement("div");
    body.className = "agenda-event-group";
    body.replaceChildren(...item.events.map(renderCalendarEvent));
    return body;
  }

  if (item.kind === "comms") {
    const body = document.createElement("div");
    body.className = "agenda-comms";
    body.append(span("", "Communications window"));
    return body;
  }

  if (item.kind === "empty") {
    const body = document.createElement("div");
    body.className = "agenda-empty";
    body.textContent = "Open slot";
    return body;
  }

  const body = document.createElement("div");
  const completed = Boolean(item.completedAt);
  body.className = "agenda-focus";
  if (completed) body.classList.add("is-complete");
  if (isNow(item) && !completed) body.classList.add("is-now");
  body.draggable = !completed;
  if (!completed) {
    body.addEventListener("click", () => startFocus(item));
    body.addEventListener("dragstart", (event) => {
      beginDrag(event, { type: "plan", slotId: item.slotId });
    });
  }

  const copy = document.createElement("div");
  copy.className = "copy";
  const titleLine = document.createElement("div");
  titleLine.className = "agenda-title-line";
  const title = document.createElement("strong");
  title.textContent = item.title;
  titleLine.append(title);
  if (completed) titleLine.append(span("done-pill", "Done"));
  if (isNow(item) && !state.active && !completed) titleLine.append(span("now-pill", "Now"));
  copy.append(titleLine, span("row-meta", item.meta));

  const controls = document.createElement("div");
  controls.className = "agenda-controls";
  const clearButton = document.createElement("button");
  clearButton.className = "clear-slot";
  clearButton.type = "button";
  clearButton.textContent = "×";
  clearButton.setAttribute("aria-label", `Clear ${item.title}`);
  clearButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void clearPlanSlot(item.slotId);
  });
  if (completed) {
    controls.append(clearButton);
  } else {
    controls.append(renderDoneButton(item, { slotId: item.slotId }), dot(item.urgency), clearButton);
  }

  body.append(copy, controls);
  return body;
}

function renderDoneButton(item, options = {}) {
  const button = document.createElement("button");
  button.className = "done-button";
  button.type = "button";
  button.disabled = isItemBusy(item);
  button.setAttribute("aria-label", `Mark ${item.title} done`);
  button.title = "Mark done";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void markItemDone(item, options);
  });
  return button;
}

function renderCalendarEvent(item) {
  const body = document.createElement("div");
  body.className = "agenda-event";
  if (item.calendarColor) body.style.setProperty("--calendar-color", item.calendarColor);
  if (item.calendarName) body.title = item.calendarName;
  const title = document.createElement("strong");
  title.textContent = item.title;
  body.append(span("event-mark", ""), title);
  return body;
}

function renderSuggestions() {
  const suggestions = getSuggestions();
  elements.suggestCount.textContent = String(suggestions.length);
  elements.suggestionsList.replaceChildren(
    ...suggestions.map((item) => {
      const row = document.createElement("div");
      row.className = "suggestion-row";

      const createButton = document.createElement("button");
      createButton.className = "suggestion-action";
      createButton.type = "button";
      createButton.textContent = "+";
      createButton.setAttribute("aria-label", `Create Linear ticket for ${item.title}`);
      createButton.addEventListener("click", () => openSuggestionModal(item));

      const dismissButton = document.createElement("button");
      dismissButton.className = "dismiss-button";
      dismissButton.type = "button";
      dismissButton.textContent = "×";
      dismissButton.setAttribute("aria-label", `Dismiss ${item.title}`);
      dismissButton.addEventListener("click", () => {
        void dismissSuggestion(item);
      });

      const trail = document.createElement("div");
      trail.className = "suggestion-controls";
      trail.append(dot(item.urgency), createButton, dismissButton);
      row.append(rowCopy(item.title, item.src), trail);
      return row;
    }),
  );
  if (suggestions.length === 0) {
    const gmailSource = state.data?.sources?.gmail;
    elements.suggestionsList.replaceChildren(emptyState(
      gmailSource?.pending
        ? "Suggested items loading"
        : gmailSource?.ok
        ? "No suggested items"
        : "Gmail scan is offline",
    ));
  }
}

function buildAgenda() {
  const calendarEvents = groupCalendarEvents(getCalendarEvents());
  const commsRows = state.settings.commsWindows.map((window) => ({
    kind: "comms",
    title: window.label,
    startMinutes: parseTimeToMinutes(window.start),
    endMinutes: parseTimeToMinutes(window.end),
  }));

  const focusRows = state.plan.slots.map((slot) => ({
    ...(slot.item || {}),
    kind: slot.item ? "focus" : "empty",
    slotId: slot.id,
    title: slot.item?.title || "Open slot",
    meta: slot.item?.meta || "",
    urgency: slot.item?.urgency || "low",
    startMinutes: parseTimeToMinutes(slot.start),
    endMinutes: parseTimeToMinutes(slot.end),
  }));

  return groupAgendaRows([...calendarEvents, ...commsRows, ...focusRows]);
}

function groupAgendaRows(rows) {
  const sortedRows = rows
    .sort((a, b) => a.startMinutes - b.startMinutes || kindOrder(a.kind) - kindOrder(b.kind));
  const groupedRows = [];
  let index = 0;

  while (index < sortedRows.length) {
    const startMinutes = sortedRows[index].startMinutes;
    const sameStart = [];
    while (index < sortedRows.length && sortedRows[index].startMinutes === startMinutes) {
      sameStart.push(sortedRows[index]);
      index += 1;
    }

    if (sameStart.length > 1) {
      groupedRows.push({
        kind: "mixed-group",
        startMinutes,
        endMinutes: Math.max(...sameStart.map((item) => item.endMinutes)),
        items: sameStart,
      });
      continue;
    }

    groupedRows.push(sameStart[0]);
  }

  return groupedRows;
}

function isCalendarAgendaItem(item) {
  return item.kind === "event" || item.kind === "event-group";
}

function getLinearItems() {
  return getAllLinearItems()
    .filter((item) => normalizePriority(item.priority) !== 0);
}

function getAllLinearItems() {
  const liveItems = state.data?.sources?.linear?.ok ? state.data.linear || [] : [];
  return dedupeItems([...state.createdPriorities, ...liveItems])
    .filter((item) => !isItemCompletedInPlan(item))
    .sort((a, b) => normalizePriority(a.priority) - normalizePriority(b.priority)
      || String(a.title).localeCompare(String(b.title)));
}

function getSuggestions() {
  const items = state.data?.sources?.gmail?.ok ? state.data.suggestions || [] : [];
  return items.filter((item) => !state.dismissedSuggestions.has(suggestionKey(item)));
}

function getCalendarEvents() {
  const events = state.data?.calendarEvents?.length ? state.data.calendarEvents : [];
  return events.map((event) => ({
    kind: "event",
    title: event.title,
    startMinutes: event.startMinutes,
    endMinutes: event.endMinutes,
    calendarId: event.calendarId,
    calendarName: event.calendarName,
    calendarColor: event.calendarColor,
  }));
}

function groupCalendarEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = String(event.startMinutes);
    const group = groups.get(key) || {
      kind: "event-group",
      startMinutes: event.startMinutes,
      endMinutes: event.endMinutes,
      events: [],
    };
    group.events.push(event);
    group.endMinutes = Math.max(group.endMinutes, event.endMinutes);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => (
    group.events.length === 1
      ? group.events[0]
      : {
        ...group,
        title: group.events.map((event) => event.title).join(", "),
      }
  ));
}

function syncPlanSlotsToAvailability() {
  const slots = generateAvailablePlanSlots();
  const nextPlan = reconcilePlanSlots(state.plan, withOccupiedCustomSlots(slots));
  if (JSON.stringify(nextPlan.slots) === JSON.stringify(state.plan.slots)) return;
  state.plan = nextPlan;
  void writeDailyPlan(state.plan);
}

function withOccupiedCustomSlots(slotTemplates) {
  const generatedIds = new Set(slotTemplates.map((slot) => slot.id));
  const customSlots = state.plan.slots
    .filter((slot) => slot.item && !generatedIds.has(slot.id))
    .map((slot) => ({ id: slot.id, start: slot.start, end: slot.end }));
  return sortPlanSlotTemplates([...slotTemplates, ...customSlots]);
}

function generateAvailablePlanSlots() {
  const blockers = mergeTimeBlocks([
    ...getCalendarEvents().map((event) => ({
      startMinutes: event.startMinutes,
      endMinutes: event.endMinutes,
    })),
    ...state.settings.commsWindows.map((window) => ({
      startMinutes: parseTimeToMinutes(window.start),
      endMinutes: parseTimeToMinutes(window.end),
    })),
  ]);
  const slots = [];
  let cursor = PLAN_DAY_START_MINUTES;

  for (const block of blockers) {
    if (block.endMinutes <= PLAN_DAY_START_MINUTES || block.startMinutes >= PLAN_DAY_END_MINUTES) {
      continue;
    }
    const blockStart = Math.max(PLAN_DAY_START_MINUTES, block.startMinutes);
    const blockEnd = Math.min(PLAN_DAY_END_MINUTES, block.endMinutes);
    fillPlanSlots(slots, cursor, blockStart);
    cursor = Math.max(cursor, blockEnd);
    if (slots.length >= PLAN_SLOT_COUNT) return slots;
  }

  fillPlanSlots(slots, cursor, PLAN_DAY_END_MINUTES);
  return slots;
}

function fillPlanSlots(slots, startMinutes, endMinutes) {
  let cursor = Math.max(PLAN_DAY_START_MINUTES, startMinutes);
  while (cursor + PLAN_SLOT_MINUTES <= endMinutes && slots.length < PLAN_SLOT_COUNT) {
    const end = cursor + PLAN_SLOT_MINUTES;
    slots.push({
      id: slotIdForWindow(cursor, end),
      start: minutesToTime(cursor),
      end: minutesToTime(end),
    });
    cursor = end;
  }
}

function reconcilePlanSlots(plan, slotTemplates) {
  const savedSlots = Array.isArray(plan?.slots) ? plan.slots : [];
  const savedById = new Map(savedSlots.map((slot) => [slot.id, slot]));
  const usedSavedSlots = new Set();
  const nextSlots = slotTemplates.map((slot) => {
    const saved = savedById.get(slot.id);
    if (saved) usedSavedSlots.add(saved.id);
    return {
      ...slot,
      item: saved?.item ? toPlanItem(saved.item) : null,
    };
  });

  const carriedItems = savedSlots
    .filter((slot) => slot.item && !usedSavedSlots.has(slot.id))
    .map((slot) => toPlanItem(slot.item));
  for (const item of carriedItems) {
    const target = nextSlots.find((slot) => !slot.item);
    if (!target) break;
    target.item = item;
  }

  return {
    version: PLAN_SCHEMA_VERSION,
    date: state.planDate,
    slots: nextSlots,
  };
}

function mergeTimeBlocks(blocks) {
  const sorted = blocks
    .filter((block) => Number.isFinite(block.startMinutes)
      && Number.isFinite(block.endMinutes)
      && block.endMinutes > block.startMinutes)
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  const merged = [];
  for (const block of sorted) {
    const previous = merged.at(-1);
    if (previous && block.startMinutes <= previous.endMinutes) {
      previous.endMinutes = Math.max(previous.endMinutes, block.endMinutes);
    } else {
      merged.push({ ...block });
    }
  }
  return merged;
}

function beginDrag(event, payload) {
  state.dragPayload = payload;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/json", JSON.stringify(payload));
}

function allowSlotDrop(event, row) {
  if (!readDragPayload(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  row.classList.add("is-drop-target");
}

async function handleSlotDrop(event, targetSlot, row) {
  event.preventDefault();
  row.classList.remove("is-drop-target");

  const payload = readDragPayload(event);
  state.dragPayload = null;
  if (!payload) return;

  if (payload.type === "priority") {
    setPlanSlotItem(targetSlot, payload.item);
  }

  if (payload.type === "plan") {
    movePlanSlotItem(payload.slotId, targetSlot);
  }

  pruneEmptyCustomPlanSlots();
  await writeDailyPlan(state.plan);
  render();
}

function readDragPayload(event) {
  const raw = event.dataTransfer?.getData("application/json");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return state.dragPayload;
    }
  }
  return state.dragPayload;
}

function setPlanSlotItem(targetSlot, item) {
  const slot = ensurePlanSlot(targetSlot);
  if (slot) slot.item = item;
}

function movePlanSlotItem(sourceSlotId, targetSlot) {
  if (sourceSlotId === targetSlot.id) return;
  const sourceSlot = state.plan.slots.find((slot) => slot.id === sourceSlotId);
  const ensuredTargetSlot = ensurePlanSlot(targetSlot);
  if (!sourceSlot || !ensuredTargetSlot || !sourceSlot.item) return;
  const targetItem = ensuredTargetSlot.item || null;
  ensuredTargetSlot.item = sourceSlot.item;
  sourceSlot.item = targetItem;
}

function ensurePlanSlot(slotTemplate) {
  let slot = state.plan.slots.find((candidate) => candidate.id === slotTemplate.id);
  if (!slot) {
    slot = { ...slotTemplate, item: null };
    state.plan.slots.push(slot);
    state.plan.slots = sortPlanSlotTemplates(state.plan.slots);
  }
  return slot;
}

function pruneEmptyCustomPlanSlots() {
  const generatedIds = new Set(generateAvailablePlanSlots().map((slot) => slot.id));
  state.plan.slots = state.plan.slots.filter((slot) => slot.item || generatedIds.has(slot.id));
}

function sortPlanSlotTemplates(slots) {
  return [...slots].sort((a, b) =>
    parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start)
    || parseTimeToMinutes(a.end) - parseTimeToMinutes(b.end)
    || String(a.id).localeCompare(String(b.id)));
}

async function clearPlanSlot(slotId) {
  const slot = state.plan.slots.find((candidate) => candidate.id === slotId);
  if (slot) slot.item = null;
  pruneEmptyCustomPlanSlots();
  await writeDailyPlan(state.plan);
  render();
}

function findCurrentPlannedItem() {
  if (state.planDate !== todayKey) return null;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const currentSlot = state.plan.slots.find((slot) => {
    const startMinutes = parseTimeToMinutes(slot.start);
    const endMinutes = parseTimeToMinutes(slot.end);
    return slot.item && !slot.item.completedAt && minutes >= startMinutes && minutes < endMinutes;
  });
  return currentSlot?.item || null;
}

function startFocus(item) {
  if (!item) return;
  state.active = {
    id: item.id || item.title,
    title: item.title,
    meta: item.meta || item.src || "",
    startedAt: Date.now(),
  };
  void writeActiveFocus(state.active);
  render();
}

function openSuggestionModal(item) {
  state.modalSuggestion = item;
  elements.ticketTitle.value = item.title;
  elements.ticketPriority.value = String(defaultPriorityForUrgency(item.urgency));
  elements.ticketStatus.textContent = item.rationale || "";
  renderTeamOptions();
  elements.ticketModal.hidden = false;
  requestAnimationFrame(() => elements.ticketTitle.focus());
}

function closeTicketModal() {
  state.modalSuggestion = null;
  if (elements.ticketModal) elements.ticketModal.hidden = true;
  if (elements.ticketForm) elements.ticketForm.reset();
  if (elements.ticketStatus) elements.ticketStatus.textContent = "";
  if (elements.ticketSubmitButton) elements.ticketSubmitButton.disabled = false;
}

function renderTeamOptions() {
  const teams = state.data?.linearTeams || [];
  const options = teams.length
    ? teams.map((team) => {
      const option = document.createElement("option");
      option.value = team.id;
      option.textContent = `${team.key} - ${team.name}`;
      return option;
    })
    : [new Option("Team unavailable", "")];
  elements.ticketTeam.replaceChildren(...options);
  elements.ticketSubmitButton.disabled = teams.length === 0;
}

async function createTicketFromModal(event) {
  event.preventDefault();
  const suggestion = state.modalSuggestion;
  if (!suggestion) return;

  const title = elements.ticketTitle.value.trim();
  const priority = Number(elements.ticketPriority.value);
  const teamId = elements.ticketTeam.value;
  if (!title || !teamId) {
    elements.ticketStatus.textContent = "Title and team are required.";
    return;
  }

  elements.ticketSubmitButton.disabled = true;
  elements.ticketStatus.textContent = "Creating in Linear...";

  try {
    const response = await companionFetch("/api/linear/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        priority,
        teamId,
        suggestion,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Linear returned ${response.status}`);
    }

    state.createdPriorities = dedupeItems([data.issue, ...state.createdPriorities]);
    await dismissSuggestion(suggestion, false);
    closeTicketModal();
    render();
  } catch (error) {
    elements.ticketSubmitButton.disabled = false;
    elements.ticketStatus.textContent = error.message;
  }
}

async function createProjectTask(project, rawTitle) {
  const title = rawTitle.trim();
  const teamId = getProjectTeamId(project);
  if (!title) return;
  if (!teamId) {
    state.projectTaskErrors[project.id] = "No team found for this project";
    renderLinear();
    return;
  }

  state.projectTaskCreating.add(project.id);
  state.projectTaskErrors[project.id] = "";
  renderLinear();

  try {
    const response = await companionFetch("/api/linear/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        teamId,
        projectId: project.id,
        priority: 0,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Linear returned ${response.status}`);
    }

    state.createdPriorities = dedupeItems([data.issue, ...state.createdPriorities]);
    state.projectTaskDrafts[project.id] = "";
    state.activeProjectTaskProjectId = "";
  } catch (error) {
    state.projectTaskErrors[project.id] = error.message;
  } finally {
    state.projectTaskCreating.delete(project.id);
    render();
  }
}

function getProjectTeamId(project) {
  return project.teams?.[0]?.id || "";
}

async function updateLinearPriority(item, priority) {
  const issueKey = item.linearId || item.id;
  if (!item.linearId || isItemBusy(item)) return;
  const previous = { ...item };
  const nextPriority = normalizePriority(priority);

  state.priorityUpdating.add(issueKey);
  applyUpdatedLinearIssue({
    ...item,
    priority: nextPriority,
    priorityLabel: priorityLabel(nextPriority),
    urgency: urgencyForPriority(nextPriority),
  });
  renderLinear();
  renderAgenda();

  try {
    const response = await companionFetch("/api/linear/issues/priority", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueId: item.linearId,
        priority: nextPriority,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Linear returned ${response.status}`);
    }

    applyUpdatedLinearIssue(data.issue);
  } catch (error) {
    applyUpdatedLinearIssue(previous);
    if (elements.syncStatus) {
      elements.syncStatus.textContent = `Linear priority update failed - ${error.message}`;
    }
  } finally {
    state.priorityUpdating.delete(issueKey);
    renderLinear();
    renderAgenda();
  }
}

async function markItemDone(item, options = {}) {
  const issueKey = item.linearId || item.id;
  if (!issueKey || isItemBusy(item)) return;

  if (!item.linearId) {
    if (options.slotId) await clearPlanSlot(options.slotId);
    return;
  }

  state.doneUpdating.add(issueKey);
  state.openPriorityMenu = null;
  renderLinear();
  renderAgenda();

  try {
    const response = await companionFetch("/api/linear/issues/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId: item.linearId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Linear returned ${response.status}`);
    }

    await removeDoneItem(data.issue || item, options);
  } catch (error) {
    if (elements.syncStatus) {
      elements.syncStatus.textContent = `Linear done update failed - ${error.message}`;
    }
  } finally {
    state.doneUpdating.delete(issueKey);
    render();
  }
}

async function removeDoneItem(item, options = {}) {
  if (state.data?.linear) {
    state.data.linear = state.data.linear.filter((candidate) => !sameLinearIssue(candidate, item));
  }
  state.createdPriorities = state.createdPriorities
    .filter((candidate) => !sameLinearIssue(candidate, item));

  let planChanged = false;
  state.plan.slots = state.plan.slots.map((slot) => {
    const shouldComplete = (options.slotId && slot.id === options.slotId)
      || (slot.item && sameLinearIssue(slot.item, item));
    if (!shouldComplete) return slot;
    planChanged = true;
    return { ...slot, item: toCompletedPlanItem({ ...(slot.item || {}), ...item }) };
  });
  if (planChanged) await writeDailyPlan(state.plan);

  if (state.active && sameLinearIssue(state.active, item)) {
    state.active = null;
    await writeActiveFocus(null);
  }
}

function isItemBusy(item) {
  const issueKey = item?.linearId || item?.id;
  return Boolean(issueKey
    && (state.priorityUpdating.has(issueKey) || state.doneUpdating.has(issueKey)));
}

function applyUpdatedLinearIssue(updatedIssue) {
  if (!updatedIssue) return;
  if (state.data?.linear) {
    state.data.linear = state.data.linear.map((item) =>
      sameLinearIssue(item, updatedIssue) ? { ...item, ...updatedIssue } : item,
    );
  }
  state.createdPriorities = state.createdPriorities.map((item) =>
    sameLinearIssue(item, updatedIssue) ? { ...item, ...updatedIssue } : item,
  );
  let planChanged = false;
  state.plan.slots = state.plan.slots.map((slot) => {
    if (!slot.item || !sameLinearIssue(slot.item, updatedIssue)) return slot;
    planChanged = true;
    return {
      ...slot,
      item: toPlanItem({ ...slot.item, ...updatedIssue }),
    };
  });
  if (planChanged) void writeDailyPlan(state.plan);
}

async function dismissSuggestion(item, shouldRender = true) {
  state.dismissedSuggestions.add(suggestionKey(item));
  await writeDismissedSuggestions([...state.dismissedSuggestions]);
  if (shouldRender) renderSuggestions();
}

async function changePlanDate(nextDateKey) {
  const dateKey = parseDateKey(nextDateKey);
  if (!dateKey || dateKey === state.planDate) return;

  state.planDate = dateKey;
  state.data = null;
  state.createdPriorities = [];
  updateUrlDateParam(dateKey);

  const [plan, dismissedSuggestions] = await Promise.all([
    readDailyPlan(dateKey),
    readDismissedSuggestions(dateKey),
  ]);
  state.plan = plan;
  state.dismissedSuggestions = new Set(dismissedSuggestions);
  render();
  await refreshData();
}

function openExternalUrl(url) {
  if (!url) return;
  if (globalThis.chrome?.tabs?.create) {
    void chrome.tabs.create({ url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function getLinearMyIssuesUrl() {
  const firstUrl = getAllLinearItems().find((item) => item.url)?.url;
  if (!firstUrl) return LINEAR_MY_ISSUES_URL;
  try {
    const url = new URL(firstUrl);
    const [, workspace] = url.pathname.split("/");
    if (!workspace) return LINEAR_MY_ISSUES_URL;
    return `${url.origin}/${workspace}/my-issues`;
  } catch {
    return LINEAR_MY_ISSUES_URL;
  }
}

function toPlanItem(item) {
  return {
    id: item.id || item.title,
    linearId: item.linearId || "",
    title: item.title,
    meta: item.meta || item.src || "",
    urgency: item.urgency || "medium",
    priority: normalizePriority(item.priority),
    priorityLabel: item.priorityLabel || priorityLabel(item.priority),
    url: item.url || "",
    projectId: item.projectId || "",
    projectName: item.projectName || "",
    projectUrl: item.projectUrl || "",
    teamId: item.teamId || "",
    teamKey: item.teamKey || "",
    completedAt: item.completedAt || "",
  };
}

function toCompletedPlanItem(item) {
  return {
    ...toPlanItem(item),
    completedAt: item.completedAt || new Date().toISOString(),
  };
}

function createEmptyPlan(dateKey, slotTemplates = defaultPlanSlots()) {
  return {
    version: PLAN_SCHEMA_VERSION,
    date: dateKey,
    slots: slotTemplates.map((slot) => ({ ...slot, item: null })),
  };
}

function normalizePlan(plan, dateKey, slotTemplates = null) {
  const templates = slotTemplates || getPlanSlotTemplates(plan);
  if (
    !plan
    || plan.version !== PLAN_SCHEMA_VERSION
    || plan.date !== dateKey
    || !Array.isArray(plan.slots)
  ) {
    return createEmptyPlan(dateKey, templates);
  }
  return {
    version: PLAN_SCHEMA_VERSION,
    date: dateKey,
    slots: templates.map((slot) => {
      const saved = plan.slots.find((candidate) => candidate.id === slot.id);
      return {
        ...slot,
        item: saved?.item ? toPlanItem(saved.item) : null,
      };
    }),
  };
}

function getPlanSlotTemplates(plan) {
  if (Array.isArray(plan?.slots) && plan.slots.length > 0) {
    return plan.slots
      .filter((slot) => slot?.id && slot.start && slot.end)
      .map((slot) => ({ id: slot.id, start: slot.start, end: slot.end }));
  }
  return defaultPlanSlots();
}

function defaultPlanSlots() {
  const slots = [];
  fillPlanSlots(slots, PLAN_DAY_START_MINUTES, PLAN_DAY_END_MINUTES);
  return slots;
}

async function readSettings() {
  if (globalThis.chrome?.storage?.sync) {
    const { settings } = await chrome.storage.sync.get("settings");
    return mergeSettings(settings);
  }

  try {
    return mergeSettings(JSON.parse(localStorage.getItem("settings") || "{}"));
  } catch {
    return mergeSettings();
  }
}

async function readDailyPlan(dateKey) {
  const key = dailyPlanKey(dateKey);
  const stored = await readLocalJson(key, null);
  const plan = normalizePlan(stored, dateKey);
  if (JSON.stringify(stored) !== JSON.stringify(plan)) {
    await writeLocalJson(key, plan);
  }
  return plan;
}

async function writeDailyPlan(plan) {
  await writeLocalJson(dailyPlanKey(state.planDate), normalizePlan(
    plan,
    state.planDate,
    getPlanSlotTemplates(plan),
  ));
}

async function readDismissedSuggestions(dateKey) {
  const dismissed = await readLocalJson(dismissedSuggestionsKey(dateKey), []);
  return Array.isArray(dismissed) ? dismissed : [];
}

async function writeDismissedSuggestions(dismissed) {
  await writeLocalJson(dismissedSuggestionsKey(state.planDate), dismissed);
}

async function readActiveFocus() {
  return await readLocalJson("activeFocus", null);
}

async function writeActiveFocus(activeFocus) {
  if (activeFocus) {
    await writeLocalJson("activeFocus", activeFocus);
  } else {
    await removeLocalValue("activeFocus");
  }
}

async function readLocalJson(key, fallback) {
  if (globalThis.chrome?.storage?.local) {
    const data = await chrome.storage.local.get(key);
    return data[key] ?? fallback;
  }

  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeLocalJson(key, value) {
  if (globalThis.chrome?.storage?.local) {
    await chrome.storage.local.set({ [key]: value });
    return;
  }
  localStorage.setItem(key, JSON.stringify(value));
}

async function removeLocalValue(key) {
  if (globalThis.chrome?.storage?.local) {
    await chrome.storage.local.remove(key);
    return;
  }
  localStorage.removeItem(key);
}

function dailyPlanKey(dateKey) {
  return `dailyPlan:${dateKey}`;
}

function dismissedSuggestionsKey(dateKey) {
  return `dismissedSuggestions:${dateKey}`;
}

function createdPrioritiesKey() {
  return `createdPriorities:${state.planDate}`;
}

function emptyState(text) {
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  return node;
}

function rowCopy(title, meta, badgeText = "") {
  const copy = document.createElement("div");
  copy.className = "copy";
  const titleLine = document.createElement("div");
  titleLine.className = "row-title-line";
  titleLine.append(span("row-title", title));
  if (badgeText) titleLine.append(span("planned-badge", badgeText));
  copy.append(titleLine, span("row-meta", meta || ""));
  return copy;
}

function dot(urgency) {
  return span(`priority-dot ${urgency || "low"}`, "");
}

function span(className, text) {
  const node = document.createElement("span");
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function formatClock(date) {
  let hour = date.getHours() % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatAgendaMinutes(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")}`;
}

function minutesToTime(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function slotIdForWindow(startMinutes, endMinutes) {
  return `slot-${minutesToTime(startMinutes).replace(":", "")}-${minutesToTime(endMinutes).replace(":", "")}`;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isNow(item) {
  if (state.planDate !== todayKey) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= item.startMinutes && minutes < item.endMinutes;
}

function getPriorityMenuPosition(trigger) {
  const rect = trigger.getBoundingClientRect();
  const menuHeight = 164;
  const opensUp = window.innerHeight - rect.bottom < 220;
  return {
    opensUp,
    right: Math.max(8, window.innerWidth - rect.right),
    top: opensUp ? Math.max(8, rect.top - menuHeight - 5) : rect.bottom + 5,
  };
}

function positionPriorityMenu(menu) {
  const position = state.openPriorityMenuPosition;
  if (!position) return;
  menu.style.right = `${position.right}px`;
  menu.style.top = `${position.top}px`;
}

function kindOrder(kind) {
  return { event: 0, "event-group": 0, comms: 1, focus: 2, empty: 3 }[kind] || 9;
}

function defaultPriorityForUrgency(urgency) {
  return { high: 2, medium: 3, low: 4 }[urgency] || 3;
}

function groupLinearItems(items) {
  return LINEAR_PRIORITIES.map((priority) => ({
    label: priority.group,
    value: priority.value,
    items: items.filter((item) => normalizePriority(item.priority) === priority.value),
  })).filter((group) => group.items.length > 0);
}

function summarizeLinearProjects(items, allProjects = []) {
  const projects = new Map(allProjects.map((project) => [project.id, {
    id: project.id,
    name: project.name,
    url: project.url || "",
    teams: project.teams || [],
    issues: [],
    count: 0,
  }]));
  for (const item of items) {
    const key = item.projectId || item.projectName || `team:${item.teamKey || "none"}`;
    const fallbackName = item.teamKey ? `No project (${item.teamKey})` : "No project";
    const existing = projects.get(key) || {
      id: key,
      name: item.projectName || fallbackName,
      url: item.projectUrl || "",
      teams: item.teamId ? [{ id: item.teamId, key: item.teamKey || "", name: item.teamKey || "" }] : [],
      issues: [],
      count: 0,
    };
    existing.count += 1;
    existing.issues.push(item);
    projects.set(key, existing);
  }
  return [...projects.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function normalizePriority(priority) {
  const value = Number(priority);
  return LINEAR_PRIORITIES.some((item) => item.value === value) ? value : 0;
}

function priorityLabel(priority) {
  return LINEAR_PRIORITIES.find((item) => item.value === normalizePriority(priority))?.label
    || "No priority";
}

function priorityClass(priority) {
  return {
    0: "none",
    1: "urgent",
    2: "high",
    3: "medium",
    4: "low",
  }[normalizePriority(priority)] || "none";
}

function urgencyForPriority(priority) {
  return LINEAR_PRIORITIES.find((item) => item.value === normalizePriority(priority))?.urgency
    || "low";
}

function sameLinearIssue(left, right) {
  return Boolean(
    (left.linearId && right.linearId && left.linearId === right.linearId)
    || (left.id && right.id && left.id === right.id),
  );
}

function isItemInPlan(item) {
  return state.plan.slots.some((slot) => slot.item && sameLinearIssue(slot.item, item));
}

function isItemCompletedInPlan(item) {
  return state.plan.slots.some((slot) =>
    slot.item?.completedAt && sameLinearIssue(slot.item, item));
}

function suggestionKey(item) {
  return item.id || item.emailId || item.threadId || item.title;
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatPlanTitle(dateKey) {
  if (dateKey === todayKey) return "Today's plan";
  const date = dateFromKey(dateKey);
  return `${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date)}'s plan`;
}

function formatPlanDateLabel(dateKey) {
  if (dateKey === todayKey) return "Today";
  if (dateKey === shiftDateKey(todayKey, 1)) return "Tomorrow";
  if (dateKey === shiftDateKey(todayKey, -1)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dateFromKey(dateKey));
}

function shiftDateKey(dateKey, days) {
  const date = dateFromKey(dateKey);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function parseDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = dateFromKey(value);
  if (Number.isNaN(date.getTime())) return null;
  return localDateKey(date) === value ? value : null;
}

function dateFromKey(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function localDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function updateUrlDateParam(dateKey) {
  const url = new URL(location.href);
  if (dateKey === todayKey) {
    url.searchParams.delete("date");
  } else {
    url.searchParams.set("date", dateKey);
  }
  history.replaceState(null, "", url.toString());
}

function buildSyncStatus(sources = {}) {
  const sourceNames = Object.entries(sources).map(([name, source]) =>
    `${name} ${source.pending ? "loading" : source.ok ? "ok" : "offline"}`,
  );
  return `Live companion connected - ${sourceNames.join(", ")}`;
}

function schedulePendingGmailRefresh(dateKey) {
  if (pendingGmailRefreshTimer) {
    clearTimeout(pendingGmailRefreshTimer);
    pendingGmailRefreshTimer = null;
  }

  if (!dateKey || !state.data?.sources?.gmail?.pending) return;

  pendingGmailRefreshTimer = setTimeout(() => {
    pendingGmailRefreshTimer = null;
    if (state.planDate === dateKey) void refreshData();
  }, 4000);
}
