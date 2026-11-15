// Synthetic UI shapes only. No provider, account, environment or disk access.
export function createSyntheticData(origin) {
  const team = { id: "fixture-team", key: "FIX", name: "Synthetic team" };
  const project = {
    id: "fixture-project", name: "Synthetic project",
    url: `${origin}/fixture/project`, teams: [team],
  };
  const issues = new Map();
  let sequence = 0;
  const labels = ["No priority", "Urgent", "High", "Medium", "Low"];

  function create({ title, priority = 3, projectId = "", teamId = team.id }) {
    if (teamId !== team.id || (projectId && projectId !== project.id)
      || typeof title !== "string" || !title.trim() || !Number.isInteger(priority) || !labels[priority]) {
      return { ok: false, error: "Invalid synthetic issue" };
    }
    const id = `FIX-${++sequence}`;
    const issue = {
      id, linearId: `fixture-issue-${sequence}`, title: title.trim().slice(0, 200),
      meta: `${id} - Synthetic project`, url: `${origin}/fixture/issue?id=${id}`,
      priority, priorityLabel: labels[priority], urgency: priority > 0 && priority <= 2 ? "high" : "medium",
      state: "Todo", updatedAt: new Date().toISOString(),
      projectId, projectName: projectId ? project.name : "", projectUrl: project.url,
      teamId: team.id, teamKey: team.key,
    };
    issues.set(issue.linearId, issue);
    return { ok: true, issue: { ...issue } };
  }

  create({ title: "Synthetic priority task", priority: 2, projectId: project.id });
  create({ title: "Synthetic task for completion", priority: 3, projectId: project.id });
  create({ title: "Synthetic unprioritized project task", priority: 0, projectId: project.id });

  return {
    create,
    update({ issueId, priority }, done = false) {
      const issue = issues.get(issueId);
      if (!issue || (!done && (!Number.isInteger(priority) || !labels[priority]))) {
        return { ok: false, error: "Invalid synthetic update" };
      }
      if (done) {
        issue.state = "Done";
        issue.completedAt = new Date().toISOString();
      } else {
        issue.priority = priority;
        issue.priorityLabel = labels[priority];
        issue.urgency = priority > 0 && priority <= 2 ? "high" : "medium";
      }
      issue.updatedAt = new Date().toISOString();
      return { ok: true, issue: { ...issue } };
    },
    snapshot() {
      return [...issues.values()].map(({ id, linearId, priority, state }) => ({ id, linearId, priority, state }));
    },
    dashboard(date) {
      const linear = [...issues.values()].filter((issue) => issue.state !== "Done").map((issue) => ({ ...issue }));
      return {
        generatedAt: new Date().toISOString(), date,
        sources: { linear: { ok: true, count: linear.length }, calendar: { ok: true, count: 1 },
          gmail: { ok: true, count: 1, pending: false } },
        linear, linearTeams: [team], linearProjects: [{ ...project, issueCount: linear.length }],
        linearViewer: { id: "fixture-viewer", name: "Synthetic viewer" },
        calendarEvents: [{ id: "fixture-event", title: "Synthetic planning meeting", startMinutes: 600,
          endMinutes: 630, calendarId: "fixture-calendar", calendarName: "Synthetic calendar", calendarColor: "#42d692" }],
        suggestions: [{ id: "fixture-suggestion", title: "Synthetic suggested follow-up", src: "Synthetic email",
          urgency: "high", rationale: "Fixture data for the suggestion create form", emailId: "fixture-email", threadId: "fixture-thread" }],
      };
    },
  };
}
