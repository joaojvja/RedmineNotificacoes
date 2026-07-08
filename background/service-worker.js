const ALARM_NAME = 'redmine-check';
const CHECK_INTERVAL_MINUTES = 5;

//Inicialização
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  console.log('[Redmine Notificações] Extension installed/reloaded. Running silent sync...');
  await silentSync();
});

//Re-verificação quando o service worker inicia (ex: após idle/encerramento)
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Redmine Notificações] Browser/SW startup. Running silent sync...');
  await silentSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkRedmine();
  }
});

//Reagir imediatamente quando as configurações mudam
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  console.log('[Redmine Notificações] Settings changed:', Object.keys(changes).join(', '));

  // Atualizar intervalo do alarme se mudou
  if (changes.checkInterval) {
    const newInterval = changes.checkInterval.newValue || CHECK_INTERVAL_MINUTES;
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: newInterval });
    console.log('[Redmine Notificações] Alarm updated to', newInterval, 'min.');
  }

  // Se notificação de prazos foi reativada, resetar flags de notificação
  if (changes.notifyDeadlines && changes.notifyDeadlines.newValue === true && changes.notifyDeadlines.oldValue === false) {
    console.log('[Redmine Notificações] Prazos re-enabled. Resetting deadline timestamps.');
    const state = await getPreviousState();
    for (const id of Object.keys(state)) {
      state[id].notifiedOverdueAt = null;
      state[id].notifiedDueSoonAt = null;
    }
    await chrome.storage.local.set({ issueState: state });
  }

  if (changes.notifyNewAssignment && changes.notifyNewAssignment.newValue === true && changes.notifyNewAssignment.oldValue === false) {
    console.log('[Redmine Notificações] Novas demandas re-enabled. Resetting state for fresh detection.');
    // Nenhum flag para resetar — novas atribuições são detectadas pela ausência de entrada anterior
  }
});

// Primeira sincronização silenciosa — salva estado para que a próxima verificação tenha uma base
async function silentSync() {
  const config = await getConfig();
  if (!config.url || !config.apiKey) return;
  try {
    const issues = await fetchAssignedIssues(config);
    await saveCurrentState(issues);

    // Atualizar badge imediatamente ao iniciar
    const urgentCount = issues.filter(i => isUrgent(i)).length;
    chrome.action.setBadgeText({ text: urgentCount > 0 ? String(urgentCount) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });

    console.log('[Redmine Notificações] Silent sync complete. State saved for', issues.length, 'issues. Badge:', urgentCount);
  } catch (e) {
    console.error('[Redmine Notificações] Silent sync failed:', e);
  }
}

//Lógica Principal de Verificação

async function checkRedmine() {
  const config = await getConfig();
  if (!config.url || !config.apiKey) {
    console.warn('[Redmine Notificações] URL or API Key not configured.');
    return;
  }

  try {
    const issues = await fetchAssignedIssues(config);
    const previousState = await getPreviousState();

    // Se não existe estado anterior, fazer sync silenciosa (primeira execução ou reinício do navegador)
    if (Object.keys(previousState).length === 0) {
      console.log('[Redmine Notificações] No previous state. Saving baseline silently.');
      await saveCurrentState(issues);
      return;
    }

    const alerts = await detectChanges(issues, previousState, config);
    console.log('[Redmine Notificações] Alerts generated:', alerts.map(a => `${a.type} #${a.issue.id}`));

    // Atualizar badge
    const urgentCount = issues.filter(i => isUrgent(i)).length;
    chrome.action.setBadgeText({ text: urgentCount > 0 ? String(urgentCount) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });

    // Enviar notificações — verificação dupla da config antes de enviar
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

    // Salvar estado atual (marcar notificações enviadas para não repetir)
    await saveCurrentState(issues, sentAlerts);

  } catch (error) {
    console.error('[Redmine Notificações] Error checking Redmine:', error);
  }
}

// Verificação final: confirmar que o tipo de notificação é permitido pela config
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

//API Redmine

async function fetchCurrentUserId(config) {
  const url = new URL('/users/current.json', config.url);
  const response = await fetch(url.toString(), {
    headers: {
      'X-Redmine-API-Key': config.apiKey,
      'Content-Type': 'application/json'
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.user?.id || null;
}

async function fetchAssignedIssues(config) {
  const url = new URL('/issues.json', config.url);
  url.searchParams.set('assigned_to_id', 'me');
  url.searchParams.set('status_id', 'open');
  url.searchParams.set('limit', '100');
  url.searchParams.set('sort', 'priority:desc,due_date:asc');
  url.searchParams.set('include', 'journals');

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
  let issues = data.issues || [];
  // Filtrar issues atribuídas a grupos se configuração habilitada
  if (config.filterGroups) {
    const userId = await fetchCurrentUserId(config);
    if (userId) {
      const before = issues.length;
      issues = issues.filter(i => i.assigned_to?.id === userId);
    }
  }

  return issues;
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
  // /users.json requer admin; alternativa: extrair responsáveis das issues abertas
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
  // Se a busca é um número, buscar por ID da issue diretamente
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
  // Filtros de data de vencimento
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
  // Log das prioridades para depuração
  const priorities = [...new Set((data.issues || []).map(i => `${i.priority?.name}(id=${i.priority?.id})`))];
  if (priorities.length > 0) console.log('[Redmine Geral] Priorities in results:', priorities.join(', '));
  return { issues: data.issues || [], totalCount: data.total_count || 0, offset: data.offset || 0, limit: data.limit || 25 };
}

async function fetchGeneralStats(config, query, filters = {}) {
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Construir parâmetros base (mesmos filtros da consulta principal)
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

  // Atrasadas: due_date <= hoje
  const overdueUrl = buildBaseUrl();
  overdueUrl.searchParams.set('due_date', `<=${today}`);

  // Vence em breve: due_date entre hoje e +3 dias
  const dueSoonUrl = buildBaseUrl();
  dueSoonUrl.searchParams.set('due_date', `><${today}|${nextWeek}`);

  // Alta prioridade: Alta(3) + Urgente(4) + Imediata(5)
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

//Detecção de Mudanças

async function detectChanges(currentIssues, previousState, config) {
  const alerts = [];
  const now = new Date();

  for (const issue of currentIssues) {
    const prev = previousState[issue.id];

    if (!prev) {
      // Nova demanda atribuída (somente se habilitado)
      if (config.notifyNewAssignment) {
        alerts.push({
          type: 'new_assignment',
          issue,
          message: `📋 Nova demanda atribuída: #${issue.id} "${issue.subject}"`
        });
      }
      continue;
    }

    // Alerta de prazo (somente se habilitado; re-notificar após período de cooldown)
    if (config.notifyDeadlines && issue.due_date) {
      const dueDate = new Date(issue.due_date);
      const daysUntilDue = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
      const overdueCooldownMs = 3 * 60 * 60 * 1000; // 3h entre lembretes de atrasadas
      const dueSoonCooldownMs = 3 * 60 * 60 * 1000; // 3h entre lembretes de vencimento próximo

      const overdueCooldownExpired = !prev.notifiedOverdueAt || (now - new Date(prev.notifiedOverdueAt)) >= overdueCooldownMs;
      const dueSoonCooldownExpired = !prev.notifiedDueSoonAt || (now - new Date(prev.notifiedDueSoonAt)) >= dueSoonCooldownMs;

      if (daysUntilDue <= 0 && overdueCooldownExpired) {
        alerts.push({
          type: 'deadline_overdue',
          issue,
          message: `⚠️ ATRASADA: #${issue.id} "${issue.subject}" — venceu ${Math.abs(daysUntilDue)} dia(s) atrás!`
        });
      } else if (daysUntilDue > 0 && daysUntilDue <= (config.deadlineWarningDays || 3) && dueSoonCooldownExpired) {
        alerts.push({
          type: 'deadline_approaching',
          issue,
          message: `⏰ Prazo próximo: #${issue.id} "${issue.subject}" — vence em ${daysUntilDue} dia(s)`
        });
      }
    }

    // Mudança de status (somente se habilitado)
    if (config.notifyStatus && prev.statusId !== issue.status?.id) {
      alerts.push({
        type: 'status_change',
        issue,
        message: `🔄 Status alterado: #${issue.id} "${issue.subject}" → ${issue.status?.name}`
      });
    }

    // Mudança de prioridade (somente se habilitado)
    if (config.notifyPriority && prev.priorityId !== issue.priority?.id) {
      alerts.push({
        type: 'priority_change',
        issue,
        message: `🔴 Prioridade alterada: #${issue.id} "${issue.subject}" → ${issue.priority?.name}`
      });
    }

    // Novos comentários (somente se habilitado)
    if (config.notifyComments) {
      // journals é confiável se veio como array com conteúdo; array vazio pode ser truncamento da API
      const journalsAvailableFromList = Array.isArray(issue.journals) && issue.journals.length > 0;
      const currentJournalCount = issue.journals?.length || 0;
      const prevJournalCount = prev.journalCount || 0;
      const issueUpdated = issue.updated_on !== prev.updatedOn;

      if (journalsAvailableFromList && currentJournalCount > prevJournalCount) {
        // Path A: Journals disponíveis no list endpoint e contagem aumentou
        let newJournals = issue.journals.slice(prevJournalCount);
        let comments = newJournals.filter(j => j.notes && j.notes.trim().length > 0);

        // Fallback: list endpoint pode não retornar 'notes' nos journals 
        if (comments.length === 0) {
          console.log('[Redmine Notificações] Journals sem notes no list endpoint para #' + issue.id + '. Buscando detalhe...');
          const detail = await fetchIssueDetail(config, issue.id);
          if (detail?.journals && detail.journals.length > prevJournalCount) {
            newJournals = detail.journals.slice(prevJournalCount);
            comments = newJournals.filter(j => j.notes && j.notes.trim().length > 0);
          }
        }

        if (comments.length > 0) {
          const lastComment = comments[comments.length - 1];
          alerts.push({
            type: 'new_comment',
            issue,
            message: `💬 Novo comentário em #${issue.id} "${issue.subject}" por ${lastComment.user?.name || 'Alguém'}`
          });
        }
        issue._journalCountVerified = true;
      } else if (!journalsAvailableFromList) {
        // Path B: List endpoint NÃO retorna journals
        const needsVerification = !prev.journalCountVerified || issueUpdated;

        if (needsVerification) {
          console.log('[Redmine Notificações] Path B para #' + issue.id + ': verificando journals via detalhe...' +
            (prev.journalCountVerified ? ' (issue atualizada)' : ' (baseline inicial)'));
          const detail = await fetchIssueDetail(config, issue.id);
          if (detail?.journals) {
            const detailCount = detail.journals.length;
            issue._resolvedJournalCount = detailCount;
            issue._journalCountVerified = true;

            // Só alertar se já tínhamos baseline verificado E a contagem aumentou
            if (prev.journalCountVerified && detailCount > prevJournalCount) {
              const newJournals = detail.journals.slice(prevJournalCount);
              const comments = newJournals.filter(j => j.notes && j.notes.trim().length > 0);
              if (comments.length > 0) {
                const lastComment = comments[comments.length - 1];
                console.log('[Redmine Notificações] Path B: novo comentário detectado em #' + issue.id + ' (' + prevJournalCount + ' → ' + detailCount + ')');
                alerts.push({
                  type: 'new_comment',
                  issue,
                  message: `💬 Novo comentário em #${issue.id} "${issue.subject}" por ${lastComment.user?.name || 'Alguém'}`
                });
              }
            } else if (!prev.journalCountVerified) {
              console.log('[Redmine Notificações] Path B: baseline estabelecido para #' + issue.id + ' (' + detailCount + ' journals)');
            }
          }
        }
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

//Notificações

function sendNotification(alert, config) {
  const notificationId = `redmine-${alert.type}-${alert.issue.id}-${Date.now()}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: '../icons/icon128.png',
    title: getNotificationTitle(alert.type),
    message: alert.message,
    priority: alert.type === 'deadline_overdue' ? 2 : 1,
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

// Clique na notificação para abrir a issue
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith('redmine-')) return;

  // Formato: redmine-{tipo}-{issueId}-{timestamp}
  // Extrair issueId: pular 'redmine-', pular o tipo (que usa underscores), obter o ID numérico
  const match = notificationId.match(/^redmine-[a-z_]+-(\d+)-\d+$/);
  if (!match) return;

  const issueId = match[1];
  const config = await getConfig();

  if (config.url && issueId) {
    chrome.tabs.create({ url: `${config.url}/issues/${issueId}` });
  }

  chrome.notifications.clear(notificationId);
});

//Helpers de Armazenamento

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
    notifyNewAssignment: true,
    filterGroups: false
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
    notifyNewAssignment: result.notifyNewAssignment,
    filterGroups: result.filterGroups
  };
}

async function getPreviousState() {
  const result = await chrome.storage.local.get({ issueState: {} });
  return result.issueState;
}

async function saveCurrentState(issues, sentAlerts = []) {
  const state = {};
  const previousState = await getPreviousState();

  // Construir um set de quais issues receberam notificações de prazo neste ciclo
  const notifiedOverdueIds = new Set();
  const notifiedDueSoonIds = new Set();
  for (const alert of sentAlerts) {
    if (alert.type === 'deadline_overdue') notifiedOverdueIds.add(alert.issue.id);
    if (alert.type === 'deadline_approaching') notifiedDueSoonIds.add(alert.issue.id);
  }

  const nowIso = new Date().toISOString();
  for (const issue of issues) {
    const prev = previousState[issue.id] || {};
    state[issue.id] = {
      statusId: issue.status?.id,
      priorityId: issue.priority?.id,
      journalCount: issue._resolvedJournalCount ?? (Array.isArray(issue.journals) && issue.journals.length > 0 ? issue.journals.length : (prev.journalCount || 0)),
      journalCountVerified: issue._journalCountVerified || (Array.isArray(issue.journals) && issue.journals.length > 0) || prev.journalCountVerified || false,
      dueDate: issue.due_date,
      updatedOn: issue.updated_on,
      // Armazenar timestamp da última notificação (para re-notificação baseada em cooldown)
      notifiedOverdueAt: notifiedOverdueIds.has(issue.id) ? nowIso : (prev.notifiedOverdueAt || null),
      notifiedDueSoonAt: notifiedDueSoonIds.has(issue.id) ? nowIso : (prev.notifiedDueSoonAt || null)
    };
  }
  await chrome.storage.local.set({ issueState: state });
}

//Tratamento de Mensagens

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
