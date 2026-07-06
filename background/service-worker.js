const ALARM_NAME = 'redmine-check';
const CHECK_INTERVAL_MINUTES = 5;

//Initialization
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  console.log('[Redmine Notificações] Extension installed/reloaded. Running silent sync...');
  await silentSync();
});

//Re-check when service worker starts up (e.g. after idle/termination)
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Redmine Notificações] Browser/SW startup. Running silent sync...');
  await silentSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkRedmine();
  }
});

//React immediately when settings change
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  console.log('[Redmine Notificações] Settings changed:', Object.keys(changes).join(', '));

  // Update alarm interval if it changed
  if (changes.checkInterval) {
    const newInterval = changes.checkInterval.newValue || CHECK_INTERVAL_MINUTES;
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: newInterval });
    console.log('[Redmine Notificações] Alarm updated to', newInterval, 'min.');
  }

  // If deadlines notification was re-enabled, reset notified flags
  if (changes.notifyDeadlines && changes.notifyDeadlines.newValue === true && changes.notifyDeadlines.oldValue === false) {
    console.log('[Redmine Notificações] Prazos re-enabled. Resetting deadline flags.');
    const state = await getPreviousState();
    for (const id of Object.keys(state)) {
      state[id].notifiedOverdue = false;
      state[id].notifiedDueSoon = false;
    }
    await chrome.storage.local.set({ issueState: state });
  }

  if (changes.notifyNewAssignment && changes.notifyNewAssignment.newValue === true && changes.notifyNewAssignment.oldValue === false) {
    console.log('[Redmine Notificações] Novas demandas re-enabled. Resetting state for fresh detection.');
    // No flag to reset — new assignments are detected by absence of prev entry
  }
});

// Silent first sync — saves state so next check has a baseline
async function silentSync() {
  const config = await getConfig();
  if (!config.url || !config.apiKey) return;
  try {
    const issues = await fetchAssignedIssues(config);
    await saveCurrentState(issues);
    console.log('[Redmine Notificações] Silent sync complete. State saved for', issues.length, 'issues.');
  } catch (e) {
    console.error('[Redmine Notificações] Silent sync failed:', e);
  }
}

//Main Check Logic

async function checkRedmine() {
  const config = await getConfig();
  if (!config.url || !config.apiKey) {
    console.warn('[Redmine Notificações] URL or API Key not configured.');
    return;
  }

  try {
    const issues = await fetchAssignedIssues(config);
    const previousState = await getPreviousState();

    // If no previous state exists, do a silent sync (first run or browser restart)
    if (Object.keys(previousState).length === 0) {
      console.log('[Redmine Notificações] No previous state. Saving baseline silently.');
      await saveCurrentState(issues);
      return;
    }

    const alerts = detectChanges(issues, previousState, config);

    console.log('[Redmine Notificações] Config:', JSON.stringify({
      'Prazos (vencimento e proximidade)': config.notifyDeadlines,
      'Mudanças de status': config.notifyStatus,
      'Mudanças de prioridade': config.notifyPriority,
      'Novos comentários': config.notifyComments,
      'Novas demandas atribuídas': config.notifyNewAssignment
    }));
    console.log('[Redmine Notificações] Alerts generated:', alerts.map(a => `${a.type} #${a.issue.id}`));

    // Update badge
    const urgentCount = issues.filter(i => isUrgent(i)).length;
    chrome.action.setBadgeText({ text: urgentCount > 0 ? String(urgentCount) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });

    // Send notifications — double-check config before sending
    const sentAlerts = [];
    for (const alert of alerts) {
      if (shouldNotify(alert.type, config)) {
        console.log('[Redmine Notificações] SENDING:', alert.type, '#' + alert.issue.id);
        sendNotification(alert, config);
        sentAlerts.push(alert);
      } else {
        console.log('[Redmine Notificações] BLOCKED:', alert.type, '#' + alert.issue.id);
      }
    }

    // Save current state (mark sent notifications so they don't repeat)
    await saveCurrentState(issues, sentAlerts);

  } catch (error) {
    console.error('[Redmine Notificações] Error checking Redmine:', error);
  }
}

// Final safety gate: verify the notification type is allowed by config
function shouldNotify(type, config) {
  switch (type) {
    case 'deadline_overdue':
    case 'deadline_approaching':
      return config.notifyDeadlines === true;
    case 'new_assignment':
      return config.notifyNewAssignment === true;
    case 'status_change':
      return config.notifyStatus === true;
    case 'priority_change':
      return config.notifyPriority === true;
    case 'new_comment':
      return config.notifyComments === true;
    default:
      return false;
  }
}

//Redmine API

async function fetchAssignedIssues(config) {
  const url = new URL('/issues.json', config.url);
  url.searchParams.set('assigned_to_id', 'me');
  url.searchParams.set('status_id', 'open');
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'priority:desc,due_date:asc');
  url.searchParams.set('include', 'journals');

  console.log('[Redmine Meus RMs] REQUEST:', url.toString());

  const response = await fetch(url.toString(), {
    headers: {
      'X-Redmine-API-Key': config.apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Redmine API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  console.log('[Redmine Meus RMs] RESPONSE: total_count=' + data.total_count + ', issues_returned=' + (data.issues?.length || 0));
  return data.issues || [];
}

async function fetchIssueDetail(config, issueId) {
  const url = new URL(`/issues/${issueId}.json`, config.url);
  url.searchParams.set('include', 'journals');

  const response = await fetch(url.toString(), {
    headers: {
      'X-Redmine-API-Key': config.apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data.issue;
}

async function fetchUsers(config) {
  // /users.json requires admin; fallback: extract assignees from open issues
  const url = new URL('/issues.json', config.url);
  url.searchParams.set('status_id', 'open');
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'updated_on:desc');
  console.log('[Redmine] Fetching assignees from issues:', url.toString());

  const response = await fetch(url.toString(), {
    headers: {
      'X-Redmine-API-Key': config.apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    console.warn('[Redmine] Failed to fetch issues for assignees:', response.status);
    return null;
  }
  const data = await response.json();
  const userMap = new Map();
  (data.issues || []).forEach(issue => {
    if (issue.assigned_to?.id && issue.assigned_to?.name) {
      userMap.set(issue.assigned_to.id, issue.assigned_to.name);
    }
  });
  const users = [...userMap.entries()].map(([id, name]) => ({ id, name }));
  console.log('[Redmine] Assignees found:', users.length, users.map(u => u.name));
  return users;
}

async function fetchStatuses(config) {
  const url = new URL('/issue_statuses.json', config.url);
  console.log('[Redmine] Fetching statuses:', url.toString());
  const response = await fetch(url.toString(), {
    headers: { 'X-Redmine-API-Key': config.apiKey, 'Content-Type': 'application/json' }
  });
  if (!response.ok) {
    console.warn('[Redmine] /issue_statuses.json failed:', response.status);
    return null;
  }
  const data = await response.json();
  console.log('[Redmine] Statuses found:', (data.issue_statuses || []).map(s => `${s.name}(id=${s.id})`));
  return data.issue_statuses || [];
}

async function fetchGeneralIssues(config, query, offset = 0, filters = {}) {
  // If query is a number, search by issue ID directly
  if (query && /^\d+$/.test(query)) {
    console.log('[Redmine Geral] Searching by issue ID:', query);
    const idUrl = new URL(`/issues/${query}.json`, config.url);
    try {
      const idResp = await fetch(idUrl.toString(), {
        headers: { 'X-Redmine-API-Key': config.apiKey, 'Content-Type': 'application/json' }
      });
      if (idResp.ok) {
        const idData = await idResp.json();
        if (idData.issue) {
          return { issues: [idData.issue], total_count: 1 };
        }
      }
    } catch (e) {
      console.warn('[Redmine Geral] ID search failed, falling back to subject search');
    }
  }

  const url = new URL('/issues.json', config.url);
  url.searchParams.set('status_id', filters.statusId || 'open');
  url.searchParams.set('limit', '25');
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', 'updated_on:desc');
  if (query) {
    url.searchParams.set('subject', `~${query}`);
  }
  if (filters.projectId) {
    url.searchParams.set('project_id', filters.projectId);
  }
  if (filters.priorityId) {
    url.searchParams.set('priority_id', filters.priorityId);
  }
  if (filters.assigneeId) {
    url.searchParams.set('assigned_to_id', filters.assigneeId);
  }
  // Due date filters
  if (filters.dueFilter) {
    const now = new Date();
    if (filters.dueFilter === 'overdue') {
      const today = now.toISOString().split('T')[0];
      url.searchParams.set('due_date', `<=${today}`);
    } else if (filters.dueFilter === 'today') {
      const today = now.toISOString().split('T')[0];
      url.searchParams.set('due_date', today);
    } else if (filters.dueFilter === 'week') {
      const today = now.toISOString().split('T')[0];
      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      url.searchParams.set('due_date', `><${today}|${nextWeek}`);
    } else if (filters.dueFilter === 'no-date') {
      url.searchParams.set('due_date', '!*');
    }
  }

  console.log('[Redmine Geral] REQUEST:', url.toString());

  const response = await fetch(url.toString(), {
    headers: {
      'X-Redmine-API-Key': config.apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Redmine API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  console.log('[Redmine Geral] RESPONSE: total_count=' + data.total_count + ', offset=' + data.offset + ', limit=' + data.limit + ', issues_returned=' + (data.issues?.length || 0));
  // Log priorities for debugging
  const priorities = [...new Set((data.issues || []).map(i => `${i.priority?.name}(id=${i.priority?.id})`))];
  if (priorities.length > 0) console.log('[Redmine Geral] Priorities in results:', priorities.join(', '));
  return { issues: data.issues || [], totalCount: data.total_count || 0, offset: data.offset || 0, limit: data.limit || 25 };
}

async function fetchGeneralStats(config, query, filters = {}) {
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Build base params (same filters as main query)
  function buildBaseUrl() {
    const url = new URL('/issues.json', config.url);
    url.searchParams.set('status_id', filters.statusId || 'open');
    url.searchParams.set('limit', '1');
    if (query) url.searchParams.set('subject', `~${query}`);
    if (filters.projectId) url.searchParams.set('project_id', filters.projectId);
    if (filters.priorityId) url.searchParams.set('priority_id', filters.priorityId);
    if (filters.assigneeId) url.searchParams.set('assigned_to_id', filters.assigneeId);
    return url;
  }

  const headers = { 'X-Redmine-API-Key': config.apiKey, 'Content-Type': 'application/json' };

  // Overdue: due_date <= today
  const overdueUrl = buildBaseUrl();
  overdueUrl.searchParams.set('due_date', `<=${today}`);

  // Due soon: due_date between today and +3 days
  const dueSoonUrl = buildBaseUrl();
  dueSoonUrl.searchParams.set('due_date', `><${today}|${nextWeek}`);

  // High priority: Alta(3) + Urgente(4) + Imediata(5)
  const highUrl = buildBaseUrl();
  highUrl.searchParams.set('priority_id', '3|4|5');

  try {
    const [overdueResp, dueSoonResp, highResp] = await Promise.all([
      fetch(overdueUrl.toString(), { headers }),
      fetch(dueSoonUrl.toString(), { headers }),
      fetch(highUrl.toString(), { headers })
    ]);

    const overdueData = overdueResp.ok ? await overdueResp.json() : { total_count: 0 };
    const dueSoonData = dueSoonResp.ok ? await dueSoonResp.json() : { total_count: 0 };
    const highData = highResp.ok ? await highResp.json() : { total_count: 0 };

    return {
      overdue: overdueData.total_count || 0,
      dueSoon: dueSoonData.total_count || 0,
      highPriority: highData.total_count || 0
    };
  } catch (e) {
    console.warn('[Redmine] Stats fetch failed:', e);
    return { overdue: 0, dueSoon: 0, highPriority: 0 };
  }
}

//Change Detection

function detectChanges(currentIssues, previousState, config) {
  const alerts = [];
  const now = new Date();

  for (const issue of currentIssues) {
    const prev = previousState[issue.id];

    if (!prev) {
      // New issue assigned (only if enabled)
      if (config.notifyNewAssignment) {
        alerts.push({
          type: 'new_assignment',
          issue,
          message: `📋 Nova demanda atribuída: #${issue.id} "${issue.subject}"`
        });
      }
      continue;
    }

    // Deadline alert (only if enabled and not already notified)
    if (config.notifyDeadlines && issue.due_date) {
      const dueDate = new Date(issue.due_date);
      const daysUntilDue = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

      if (daysUntilDue <= 0 && !prev.notifiedOverdue) {
        alerts.push({
          type: 'deadline_overdue',
          issue,
          message: `⚠️ ATRASADA: #${issue.id} "${issue.subject}" — venceu ${Math.abs(daysUntilDue)} dia(s) atrás!`
        });
      } else if (daysUntilDue > 0 && daysUntilDue <= (config.deadlineWarningDays || 3) && !prev.notifiedDueSoon) {
        alerts.push({
          type: 'deadline_approaching',
          issue,
          message: `⏰ Prazo próximo: #${issue.id} "${issue.subject}" — vence em ${daysUntilDue} dia(s)`
        });
      }
    }

    // Status change (only if enabled)
    if (config.notifyStatus && prev.statusId !== issue.status?.id) {
      alerts.push({
        type: 'status_change',
        issue,
        message: `🔄 Status alterado: #${issue.id} "${issue.subject}" → ${issue.status?.name}`
      });
    }

    // Priority change (only if enabled)
    if (config.notifyPriority && prev.priorityId !== issue.priority?.id) {
      alerts.push({
        type: 'priority_change',
        issue,
        message: `🔴 Prioridade alterada: #${issue.id} "${issue.subject}" → ${issue.priority?.name}`
      });
    }

    // New comments (only if enabled)
    if (config.notifyComments && issue.journals && issue.journals.length > (prev.journalCount || 0)) {
      const newJournals = issue.journals.slice(prev.journalCount || 0);
      const comments = newJournals.filter(j => j.notes && j.notes.trim().length > 0);
      if (comments.length > 0) {
        const lastComment = comments[comments.length - 1];
        alerts.push({
          type: 'new_comment',
          issue,
          message: `💬 Novo comentário em #${issue.id} "${issue.subject}" por ${lastComment.user?.name || 'Alguém'}`
        });
      }
    }
  }

  return alerts;
}

function isUrgent(issue) {
  if (!issue.due_date) return false;
  const now = new Date();
  const dueDate = new Date(issue.due_date);
  const daysUntilDue = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
  return daysUntilDue <= 1;
}

//Notifications

function sendNotification(alert, config) {
  const notificationId = `redmine-${alert.type}-${alert.issue.id}-${Date.now()}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: '../icons/icon128.png',
    title: getNotificationTitle(alert.type),
    message: alert.message,
    priority: alert.type === 'deadline_overdue' ? 2 : 1,
    requireInteraction: alert.type === 'deadline_overdue'
  });
}

function getNotificationTitle(type) {
  const titles = {
    deadline_overdue: 'Redmine — Prazo Vencido!',
    deadline_approaching: 'Redmine — Prazo Próximo',
    new_assignment: 'Redmine — Nova Demanda',
    status_change: 'Redmine — Status Atualizado',
    priority_change: 'Redmine — Prioridade Alterada',
    new_comment: 'Redmine — Novo Comentário'
  };
  return titles[type] || 'Redmine Notificações';
}

// Click notification to open issue
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('redmine-')) return;

  // Format: redmine-{type}-{issueId}-{timestamp}
  // Extract issueId: skip 'redmine-', then skip the type (which uses underscores), get the numeric ID
  const match = notificationId.match(/^redmine-[a-z_]+-(\d+)-\d+$/);
  if (!match) return;

  const issueId = match[1];
  const config = await getConfig();

  if (config.url && issueId) {
    chrome.tabs.create({ url: `${config.url}/issues/${issueId}` });
  }

  chrome.notifications.clear(notificationId);
});

//Storage Helpers

async function getConfig() {
  const result = await chrome.storage.sync.get({
    redmineUrl: '',
    apiKey: '',
    checkInterval: 5,
    deadlineWarningDays: 3,
    notifyDeadlines: true,
    notifyStatus: true,
    notifyPriority: true,
    notifyComments: true,
    notifyNewAssignment: true
  });

  return {
    url: result.redmineUrl.replace(/\/$/, ''),
    apiKey: result.apiKey,
    checkInterval: result.checkInterval,
    deadlineWarningDays: result.deadlineWarningDays,
    notifyDeadlines: result.notifyDeadlines,
    notifyStatus: result.notifyStatus,
    notifyPriority: result.notifyPriority,
    notifyComments: result.notifyComments,
    notifyNewAssignment: result.notifyNewAssignment
  };
}

async function getPreviousState() {
  const result = await chrome.storage.local.get({ issueState: {} });
  return result.issueState;
}

async function saveCurrentState(issues, sentAlerts = []) {
  const state = {};
  const previousState = await getPreviousState();

  // Build a set of which issues got deadline notifications sent
  const notifiedOverdueIds = new Set();
  const notifiedDueSoonIds = new Set();
  for (const alert of sentAlerts) {
    if (alert.type === 'deadline_overdue') notifiedOverdueIds.add(alert.issue.id);
    if (alert.type === 'deadline_approaching') notifiedDueSoonIds.add(alert.issue.id);
  }

  for (const issue of issues) {
    const prev = previousState[issue.id] || {};
    state[issue.id] = {
      statusId: issue.status?.id,
      priorityId: issue.priority?.id,
      journalCount: issue.journals?.length || 0,
      dueDate: issue.due_date,
      updatedOn: issue.updated_on,
      // Mark as notified only if we actually sent the notification
      notifiedOverdue: prev.notifiedOverdue || notifiedOverdueIds.has(issue.id),
      notifiedDueSoon: prev.notifiedDueSoon || notifiedDueSoonIds.has(issue.id)
    };
  }
  await chrome.storage.local.set({ issueState: state });
}

//Message Handling

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkNow') {
    checkRedmine().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === 'getIssues') {
    getConfig().then(config => {
      if (!config.url || !config.apiKey) {
        sendResponse({ error: 'not_configured' });
        return;
      }
      fetchAssignedIssues(config).then(issues => {
        sendResponse({ issues });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
    });
    return true;
  }
  if (message.action === 'getGeneralIssues') {
    getConfig().then(config => {
      if (!config.url || !config.apiKey) {
        sendResponse({ error: 'not_configured' });
        return;
      }
      const filters = {
        projectId: message.projectId || '',
        priorityId: message.priorityId || '',
        statusId: message.statusId || '',
        assigneeId: message.assigneeId || '',
        dueFilter: message.dueFilter || ''
      };
      fetchGeneralIssues(config, message.query || '', message.offset || 0, filters).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ error: err.message });
      });
    });
    return true;
  }
  if (message.action === 'getUsers') {
    getConfig().then(config => {
      if (!config.url || !config.apiKey) {
        sendResponse({ error: 'not_configured' });
        return;
      }
      fetchUsers(config).then(users => {
        sendResponse({ users: users || [] });
      }).catch(err => {
        sendResponse({ error: err.message });
      });
    });
    return true;
  }
  if (message.action === 'getGeneralStats') {
    getConfig().then(config => {
      if (!config.url || !config.apiKey) {
        sendResponse({ overdue: 0, dueSoon: 0, highPriority: 0 });
        return;
      }
      const filters = {
        projectId: message.projectId || '',
        priorityId: message.priorityId || '',
        statusId: message.statusId || '',
        assigneeId: message.assigneeId || '',
        dueFilter: message.dueFilter || ''
      };
      fetchGeneralStats(config, message.query || '', filters).then(stats => {
        sendResponse(stats);
      }).catch(() => {
        sendResponse({ overdue: 0, dueSoon: 0, highPriority: 0 });
      });
    });
    return true;
  }
  if (message.action === 'getStatuses') {
    getConfig().then(config => {
      if (!config.url || !config.apiKey) {
        sendResponse({ statuses: [] });
        return;
      }
      fetchStatuses(config).then(statuses => {
        sendResponse({ statuses: statuses || [] });
      }).catch(() => {
        sendResponse({ statuses: [] });
      });
    });
    return true;
  }
});
