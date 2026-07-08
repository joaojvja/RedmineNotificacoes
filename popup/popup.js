document.addEventListener('DOMContentLoaded', () => {
  const btnRefresh = document.getElementById('btn-refresh');
  const btnSettings = document.getElementById('btn-settings');
  const linkSettings = document.getElementById('link-settings');
  const searchInput = document.getElementById('search-input');
  const filterProject = document.getElementById('filter-project');
  const filterPriority = document.getElementById('filter-priority');
  const filterDue = document.getElementById('filter-due');
  const filterStatus = document.getElementById('filter-status');
  const tabs = document.querySelectorAll('.tab');

  btnRefresh.addEventListener('click', () => {
    if (activeTab === 'mine') loadIssues();
    else if (activeTab === 'favorites') loadFavorites();
    else loadGeneralIssues();
  });
  btnSettings.addEventListener('click', openSettings);
  linkSettings.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });

  searchInput.addEventListener('input', () => {
    if (activeTab === 'mine') applyFilters();
    else if (activeTab === 'favorites') applyFavoriteFilters();
  });
  searchInput.addEventListener('keydown', (e) => {
    console.log('[Popup] keydown:', e.key, 'activeTab:', activeTab);
    if (e.key === 'Enter') {
      if (activeTab === 'general') { generalPage = 0; loadGeneralIssues(); }
      else if (activeTab === 'favorites') applyFavoriteFilters();
    }
  });
  document.getElementById('btn-search').addEventListener('click', () => {
    console.log('[Popup] btn-search clicked, activeTab:', activeTab);
    if (activeTab === 'mine') applyFilters();
    else if (activeTab === 'favorites') applyFavoriteFilters();
    else { generalPage = 0; loadGeneralIssues(); }
  });
  filterProject.addEventListener('change', () => {
    if (activeTab === 'mine') applyFilters();
    else if (activeTab === 'favorites') applyFavoriteFilters();
    else { generalPage = 0; loadGeneralIssues(); }
  });
  filterPriority.addEventListener('change', () => {
    if (activeTab === 'mine') applyFilters();
    else { generalPage = 0; loadGeneralIssues(); }
  });
  filterDue.addEventListener('change', () => {
    if (activeTab === 'mine') applyFilters();
    else { generalPage = 0; loadGeneralIssues(); }
  });
  filterStatus.addEventListener('change', () => {
    if (activeTab === 'mine') applyFilters();
    else if (activeTab === 'favorites') applyFavoriteFilters();
    else { generalPage = 0; loadGeneralIssues(); }
  });

  // Alternância de abas
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      // Resetar todos os filtros ao trocar de aba
      searchInput.value = '';
      filterProject.value = '';
      filterPriority.value = '';
      filterDue.value = '';
      filterStatus.value = '';
      document.getElementById('filter-assignee').value = '';

      // Restaurar visibilidade de todas as linhas de filtro primeiro
      document.querySelector('.filters-row-2').style.display = '';
      document.getElementById('filter-priority').style.display = '';
      document.getElementById('filter-due').style.display = '';

      if (activeTab === 'mine') {
        document.getElementById('paginator').classList.add('hidden');
        document.querySelector('.filters-row-3').style.display = 'none';
        document.getElementById('btn-search').classList.add('hidden');
        loadIssues();
      } else if (activeTab === 'favorites') {
        document.getElementById('paginator').classList.add('hidden');
        document.querySelector('.filters-row-3').style.display = 'none';
        document.getElementById('filter-priority').style.display = 'none';
        document.getElementById('filter-due').style.display = 'none';
        document.getElementById('btn-search').classList.add('hidden');
        loadFavorites();
      } else {
        document.querySelector('.filters-row-3').style.display = 'flex';
        document.getElementById('btn-search').classList.remove('hidden');
        generalPage = 0;
        generalFiltersPopulated = false;
        loadGeneralIssues();
      }
    });
  });

  const filterAssignee = document.getElementById('filter-assignee');
  filterAssignee.addEventListener('change', () => {
    if (activeTab === 'general') { generalPage = 0; loadGeneralIssues(); }
  });

  document.getElementById('btn-prev').addEventListener('click', () => {
    if (generalPage > 0) {
      generalPage--;
      loadGeneralIssues();
    }
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    const totalPages = Math.ceil(generalTotalCount / generalLimit);
    if (generalPage < totalPages - 1) {
      generalPage++;
      loadGeneralIssues();
    }
  });

  // Ocultar filtro de responsável e botão de busca inicialmente (apenas para aba Geral)
  document.querySelector('.filters-row-3').style.display = 'none';
  document.getElementById('btn-search').classList.add('hidden');

  // Popular filtro de status na inicialização (usado por ambas as abas)
  populateStatusFilter();

  // Carregar IDs dos favoritos antes de renderizar qualquer issue
  loadFavoriteIds().then(() => loadIssues());
});

let allIssues = [];
let allGeneralIssues = [];
let allFavoriteIssues = [];
let activeTab = 'mine';
let generalPage = 0;
let generalTotalCount = 0;
let generalLimit = 25;
let generalFiltersPopulated = false;
let favoriteIds = new Set();

function openSettings() {
  chrome.runtime.openOptionsPage();
}

//Favoritos

async function loadFavoriteIds() {
  const data = await chrome.storage.local.get({ favorites: [] });
  favoriteIds = new Set(data.favorites);
}

async function saveFavoriteIds() {
  await chrome.storage.local.set({ favorites: [...favoriteIds] });
}

async function toggleFavorite(issueId) {
  if (favoriteIds.has(issueId)) {
    favoriteIds.delete(issueId);
  } else {
    favoriteIds.add(issueId);
  }
  await saveFavoriteIds();
}

async function loadFavorites() {
  showSection('loading');

  await loadFavoriteIds();
  if (favoriteIds.size === 0) {
    hideAll();
    document.getElementById('filters-bar').classList.add('hidden');
    document.getElementById('issues-list').innerHTML = '<div class="no-results">Nenhum favorito salvo. Clique na ⭐ de uma demanda para favoritar.</div>';
    document.getElementById('issues-list').classList.remove('hidden');
    return;
  }

  try {
    const config = await getConfig();
    if (!config.url || !config.apiKey) {
      showSection('not-configured');
      return;
    }

    const issues = [];
    const idsToRemove = [];
    for (const id of favoriteIds) {
      try {
        const data = await apiFetch(`/issues/${id}.json`);
        if (data && data.issue) issues.push(data.issue);
      } catch (e) {
        // A issue pode ter sido deletada
        idsToRemove.push(id);
      }
    }

    // Limpar issues deletadas dos favoritos
    if (idsToRemove.length > 0) {
      idsToRemove.forEach(id => favoriteIds.delete(id));
      await saveFavoriteIds();
    }

    if (issues.length === 0) {
      hideAll();
      document.getElementById('filters-bar').classList.add('hidden');
      document.getElementById('issues-list').innerHTML = '<div class="no-results">Nenhum favorito encontrado.</div>';
      document.getElementById('issues-list').classList.remove('hidden');
      return;
    }

    allFavoriteIssues = issues;
    populateProjectFilter(allFavoriteIssues);
    document.getElementById('filters-bar').classList.remove('hidden');
    renderIssues(allFavoriteIssues);
    document.getElementById('paginator').classList.add('hidden');
  } catch (err) {
    showError(err.message);
  }
}

function applyFavoriteFilters() {
  const search = document.getElementById('search-input').value.toLowerCase().trim();
  const projectId = document.getElementById('filter-project').value;
  const statusFilter = document.getElementById('filter-status').value;

  let filtered = allFavoriteIssues.filter(issue => {
    if (search) {
      const text = `#${issue.id} ${issue.subject} ${issue.project?.name || ''} ${issue.status?.name || ''}`.toLowerCase();
      if (!text.includes(search)) return false;
    }
    if (projectId && String(issue.project?.id) !== projectId) return false;
    if (statusFilter && String(issue.status?.id) !== statusFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    document.getElementById('issues-list').innerHTML = '<div class="no-results">Nenhum favorito encontrado com os filtros aplicados.</div>';
    hideAll();
    document.getElementById('filters-bar').classList.remove('hidden');
    document.getElementById('issues-list').classList.remove('hidden');
    return;
  }

  renderIssues(filtered);
  document.getElementById('filters-bar').classList.remove('hidden');
  document.getElementById('paginator').classList.add('hidden');
}

//Camada de API (busca diretamente, igual à página de opções)

async function getConfig() {
  const config = await chrome.storage.sync.get({ redmineUrl: '', apiKey: '' });
  return { url: (config.redmineUrl || '').replace(/\/$/, ''), apiKey: config.apiKey || '' };
}

async function apiFetch(path, params = {}) {
  const config = await getConfig();
  if (!config.url || !config.apiKey) return { error: 'not_configured' };

  const url = new URL(path, config.url);
  Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });

  console.log('[Popup] FETCH:', url.toString());
  const response = await fetch(url.toString(), {
    headers: { 'X-Redmine-API-Key': config.apiKey, 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Redmine API error: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function fetchCurrentUserId() {
  try {
    const data = await apiFetch('/users/current.json');
    return data.user?.id || null;
  } catch (e) {
    return null;
  }
}

async function loadIssues() {
  showSection('loading');

  try {
    const config = await getConfig();
    if (!config.url || !config.apiKey) {
      showSection('not-configured');
      return;
    }

    const data = await apiFetch('/issues.json', {
      assigned_to_id: 'me',
      status_id: 'open',
      limit: '100',
      sort: 'priority:desc,due_date:asc'
    });

    let issues = data.issues || [];

    // Filtrar issues atribuídas a grupos se configuração habilitada
    const settings = await chrome.storage.sync.get({ filterGroups: false });
    if (settings.filterGroups) {
      const userId = await fetchCurrentUserId();
      if (userId) {
        issues = issues.filter(i => i.assigned_to?.id === userId);
      }
    }

    if (issues.length === 0) {
      showSection('empty');
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    allIssues = issues;

    // Atualizar badge imediatamente baseado na contagem de atrasadas
    const overdueCount = issues.filter(i => i.due_date && daysUntilDue(i.due_date) < 0).length;
    chrome.action.setBadgeText({ text: overdueCount > 0 ? String(overdueCount) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });

    populateProjectFilter(allIssues);
    document.getElementById('filters-bar').classList.remove('hidden');
    renderIssues(allIssues);
  } catch (err) {
    showError(err.message);
  }
}

function renderIssues(issues) {
  const now = new Date();
  const listEl = document.getElementById('issues-list');
  const summaryEl = document.getElementById('summary');

  // Calcular estatísticas
  let overdue = 0;
  let dueSoon = 0;
  let highPriority = 0;

  issues.forEach(issue => {
    if (issue.due_date) {
      const days = daysUntilDue(issue.due_date);
      if (days < 0) overdue++;
      else if (days <= 3) dueSoon++;
    }
    if (issue.priority && issue.priority.id >= 3) highPriority++;
  });

  // Na aba Geral, sempre mostrar total da API (já filtrado no servidor)
  if (activeTab === 'general') {
    document.getElementById('total-count').textContent = generalTotalCount;
    // Estatísticas serão atualizadas por loadGeneralStats()
  } else {
    document.getElementById('total-count').textContent = issues.length;
    document.getElementById('overdue-count').textContent = overdue;
    document.getElementById('due-soon-count').textContent = dueSoon;
    document.getElementById('high-count').textContent = highPriority;
  }

  // Ordenar: atrasadas primeiro, depois por data de vencimento, depois prioridade
  issues.sort((a, b) => {
    const aDays = a.due_date ? daysUntilDue(a.due_date) : 999;
    const bDays = b.due_date ? daysUntilDue(b.due_date) : 999;
    if (aDays !== bDays) return aDays - bDays;
    return (b.priority?.id || 0) - (a.priority?.id || 0);
  });

  // Renderizar cards
  listEl.innerHTML = '';
  issues.forEach(issue => {
    listEl.appendChild(createIssueCard(issue));
  });

  hideAll();
  document.getElementById('filters-bar').classList.remove('hidden');
  summaryEl.classList.remove('hidden');
  listEl.classList.remove('hidden');
}

function createIssueCard(issue) {
  const card = document.createElement('div');
  card.className = `issue-card ${getPriorityClass(issue.priority)} ${isOverdue(issue) ? 'overdue' : ''}`;

  const days = issue.due_date ? daysUntilDue(issue.due_date) : null;
  const isFav = favoriteIds.has(issue.id);

  let dueBadge = '';
  if (days !== null) {
    if (days < 0) {
      dueBadge = `<span class="overdue-badge">⚠️ ${Math.abs(days)}d atrasada</span>`;
    } else if (days === 0) {
      dueBadge = `<span class="overdue-badge">⚠️ Vence hoje!</span>`;
    } else if (days <= 3) {
      dueBadge = `<span class="due-soon-badge">⏰ ${days}d restantes</span>`;
    } else {
      dueBadge = `<span>📅 ${formatDate(issue.due_date)}</span>`;
    }
  }

  card.innerHTML = `
    <div class="issue-header">
      <span class="issue-id">#${issue.id} — ${escapeHtml(issue.project?.name || '')}</span>
      <div class="issue-header-right">
        <button class="btn-favorite ${isFav ? 'is-favorite' : ''}" data-issue-id="${issue.id}" title="${isFav ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}">⭐</button>
        <span class="issue-priority ${getPriorityLabel(issue.priority)}">${escapeHtml(issue.priority?.name || '')}</span>
      </div>
    </div>
    <div class="issue-subject">${escapeHtml(issue.subject)}</div>
    <div class="issue-meta">
      <span>📊 ${escapeHtml(issue.status?.name || '')}</span>
      ${issue.assigned_to ? `<span>👤 ${escapeHtml(issue.assigned_to.name)}</span>` : ''}
      ${issue.done_ratio ? `<span>✅ ${issue.done_ratio}%</span>` : ''}
      ${dueBadge}
    </div>
  `;

  // Clique no botão de favorito
  const favBtn = card.querySelector('.btn-favorite');
  favBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleFavorite(issue.id);
    favBtn.classList.toggle('is-favorite');
    favBtn.title = favoriteIds.has(issue.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos';
    // Se na aba de favoritos, remover o card
    if (activeTab === 'favorites') {
      card.remove();
      if (favoriteIds.size === 0) {
        document.getElementById('issues-list').innerHTML = '<div class="no-results">Nenhum favorito salvo. Clique na ⭐ de uma demanda para favoritar.</div>';
      }
    }
  });

  card.addEventListener('click', () => {
    chrome.storage.sync.get('redmineUrl', (result) => {
      if (result.redmineUrl) {
        chrome.tabs.create({ url: `${result.redmineUrl.replace(/\/$/, '')}/issues/${issue.id}` });
      }
    });
  });

  return card;
}

//Filtros

function populateProjectFilter(issues) {
  const select = document.getElementById('filter-project');
  const projectMap = new Map();
  issues.forEach(i => {
    if (i.project?.id && i.project?.name) {
      projectMap.set(String(i.project.id), i.project.name);
    }
  });
  select.innerHTML = '<option value="">Todos projetos</option>';
  projectMap.forEach((name, id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

function applyFilters() {
  const search = document.getElementById('search-input').value.toLowerCase().trim();
  const projectId = document.getElementById('filter-project').value;
  const priorityId = document.getElementById('filter-priority').value;
  const dueFilter = document.getElementById('filter-due').value;
  const statusFilter = document.getElementById('filter-status').value;

  let filtered = allIssues.filter(issue => {
    // Busca
    if (search) {
      const text = `#${issue.id} ${issue.subject} ${issue.project?.name || ''} ${issue.status?.name || ''}`.toLowerCase();
      if (!text.includes(search)) return false;
    }
    // Filtro de projeto
    if (projectId && String(issue.project?.id) !== projectId) return false;
    // Filtro de prioridade
    if (priorityId && String(issue.priority?.id) !== priorityId) return false;
    // Filtro de status (por ID)
    if (statusFilter && String(issue.status?.id) !== statusFilter) return false;
    // Filtro de data de vencimento
    if (dueFilter) {
      const days = issue.due_date ? daysUntilDue(issue.due_date) : null;
      if (dueFilter === 'overdue' && (days === null || days >= 0)) return false;
      if (dueFilter === 'today' && (days === null || days !== 0)) return false;
      if (dueFilter === 'week' && (days === null || days < 0 || days > 7)) return false;
      if (dueFilter === 'no-date' && issue.due_date) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    document.getElementById('total-count').textContent = '0';
    document.getElementById('overdue-count').textContent = '0';
    document.getElementById('due-soon-count').textContent = '0';
    document.getElementById('high-count').textContent = '0';
    document.getElementById('issues-list').innerHTML = '<div class="no-results">Nenhuma demanda encontrada com os filtros aplicados.</div>';
    hideAll();
    document.getElementById('filters-bar').classList.remove('hidden');
    document.getElementById('summary').classList.remove('hidden');
    document.getElementById('issues-list').classList.remove('hidden');
    return;
  }

  renderIssues(filtered);
  document.getElementById('filters-bar').classList.remove('hidden');
}

//Aba Geral

async function loadGeneralIssues() {
  showSection('loading');

  const offset = generalPage * generalLimit;
  const filters = {
    query: document.getElementById('search-input').value.trim(),
    projectId: document.getElementById('filter-project').value,
    priorityId: document.getElementById('filter-priority').value,
    statusId: document.getElementById('filter-status').value,
    assigneeId: document.getElementById('filter-assignee').value,
    dueFilter: document.getElementById('filter-due').value
  };

  try {
    const config = await getConfig();
    if (!config.url || !config.apiKey) {
      showSection('not-configured');
      return;
    }

    const params = {
      status_id: filters.statusId || 'open',
      limit: '25',
      offset: String(offset),
      sort: 'updated_on:desc'
    };

    // Se a busca é um número
    if (filters.query && /^\d+$/.test(filters.query)) {
      try {
        const idData = await apiFetch(`/issues/${filters.query}.json`);
        if (idData && idData.issue) {
          generalTotalCount = 1;
          allGeneralIssues = [idData.issue];
          document.getElementById('filters-bar').classList.remove('hidden');
          document.getElementById('total-count').textContent = 1;
          updateStatsFromIssues(allGeneralIssues);
          renderIssues(allGeneralIssues);
          document.getElementById('paginator').classList.add('hidden');
          return;
        }
      } catch (e) {
        // ID não encontrado
        console.log('[Popup] Issue ID not found, trying subject search...');
      }
    }

    if (filters.query) params.subject = `~${filters.query}`;
    if (filters.projectId) params.project_id = filters.projectId;
    if (filters.priorityId) params.priority_id = filters.priorityId;
    if (filters.assigneeId) params.assigned_to_id = filters.assigneeId;
    if (filters.dueFilter) {
      const today = new Date().toISOString().split('T')[0];
      const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      if (filters.dueFilter === 'overdue') params.due_date = `<=${today}`;
      else if (filters.dueFilter === 'today') params.due_date = `${today}`;
      else if (filters.dueFilter === 'week') params.due_date = `><${today}|${weekLater}`;
      else if (filters.dueFilter === 'no-date') params.due_date = '!*';
    }

    const data = await apiFetch('/issues.json', params);

    generalTotalCount = data.total_count || 0;
    generalLimit = data.limit || 25;
    allGeneralIssues = data.issues || [];

    if (allGeneralIssues.length === 0) {
      hideAll();
      document.getElementById('filters-bar').classList.remove('hidden');
      document.getElementById('issues-list').innerHTML = '<div class="no-results">Nenhuma demanda encontrada.</div>';
      document.getElementById('issues-list').classList.remove('hidden');
      document.getElementById('paginator').classList.add('hidden');
      return;
    }

    if (!generalFiltersPopulated) {
      populateProjectFilter(allGeneralIssues);
      populateAssigneeFilter();
      populateStatusFilter();
      generalFiltersPopulated = true;
    }
    document.getElementById('filters-bar').classList.remove('hidden');

    document.getElementById('total-count').textContent = generalTotalCount;

    renderIssues(allGeneralIssues);
    updatePaginator();
    loadGeneralStats();
  } catch (err) {
    showError(err.message);
  }
}

async function loadGeneralStats() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const baseParams = {};
    const query = document.getElementById('search-input').value.trim();
    const projectId = document.getElementById('filter-project').value;
    const priorityId = document.getElementById('filter-priority').value;
    const statusId = document.getElementById('filter-status').value;
    const assigneeId = document.getElementById('filter-assignee').value;
    const dueFilter = document.getElementById('filter-due').value;

    if (query) baseParams.subject = `~${query}`;
    if (projectId) baseParams.project_id = projectId;
    if (priorityId) baseParams.priority_id = priorityId;
    if (assigneeId) baseParams.assigned_to_id = assigneeId;
    baseParams.status_id = statusId || 'open';
    baseParams.limit = '1';

    let overdueCount = 0;
    let dueSoonCount = 0;
    let highCount = 0;

    if (dueFilter === 'overdue') {
      // Todas já são atrasadas; "vence em breve" = 0
      const [totalData, highData] = await Promise.all([
        apiFetch('/issues.json', { ...baseParams, due_date: `<=${today}` }),
        apiFetch('/issues.json', { ...baseParams, due_date: `<=${today}`, priority_id: '3|4|5' })
      ]);
      overdueCount = totalData.total_count || 0;
      dueSoonCount = 0;
      highCount = highData.total_count || 0;
    } else if (dueFilter === 'today') {
      // Vence hoje: não está atrasada, mas está "em breve"
      const [totalData, highData] = await Promise.all([
        apiFetch('/issues.json', { ...baseParams, due_date: `${today}` }),
        apiFetch('/issues.json', { ...baseParams, due_date: `${today}`, priority_id: '3|4|5' })
      ]);
      overdueCount = 0;
      dueSoonCount = totalData.total_count || 0;
      highCount = highData.total_count || 0;
    } else if (dueFilter === 'week') {
      // Dentro da semana: atrasadas=0, "em breve" = subset até 3 dias
      const [dueSoonData, highData] = await Promise.all([
        apiFetch('/issues.json', { ...baseParams, due_date: `><${today}|${soon}` }),
        apiFetch('/issues.json', { ...baseParams, due_date: `><${today}|${weekLater}`, priority_id: '3|4|5' })
      ]);
      overdueCount = 0;
      dueSoonCount = dueSoonData.total_count || 0;
      highCount = highData.total_count || 0;
    } else if (dueFilter === 'no-date') {
      // Sem prazo: atrasadas=0, em breve=0
      const highData = await apiFetch('/issues.json', { ...baseParams, due_date: '!*', priority_id: '3|4|5' });
      overdueCount = 0;
      dueSoonCount = 0;
      highCount = highData.total_count || 0;
    } else {
      // Sem filtro de prazo: comportamento padrão
      const [overdueData, dueSoonData, highData] = await Promise.all([
        apiFetch('/issues.json', { ...baseParams, due_date: `<=${today}` }),
        apiFetch('/issues.json', { ...baseParams, due_date: `><${today}|${soon}` }),
        apiFetch('/issues.json', { ...baseParams, priority_id: '3|4|5' })
      ]);
      overdueCount = overdueData.total_count || 0;
      dueSoonCount = dueSoonData.total_count || 0;
      highCount = highData.total_count || 0;
    }

    document.getElementById('overdue-count').textContent = overdueCount;
    document.getElementById('due-soon-count').textContent = dueSoonCount;
    document.getElementById('high-count').textContent = highCount;
  } catch (e) {
    // Estatísticas não são críticas, falhar silenciosamente
  }
}

async function populateStatusFilter() {
  try {
    const data = await apiFetch('/issue_statuses.json');
    const statuses = data.issue_statuses || [];
    if (statuses.length > 0) {
      const select = document.getElementById('filter-status');
      select.innerHTML = '<option value="">Situação</option>';
      statuses.forEach(s => {
        const opt = document.createElement('option');
        opt.value = String(s.id);
        opt.textContent = s.name;
        select.appendChild(opt);
      });
    }
  } catch (e) {
    // Não-crítico
  }
}

async function populateAssigneeFilter() {
  try {
    // Obter responsáveis das issues abertas
    const data = await apiFetch('/issues.json', { status_id: 'open', limit: '100', sort: 'updated_on:desc' });
    const userMap = new Map();
    (data.issues || []).forEach(issue => {
      if (issue.assigned_to?.id && issue.assigned_to?.name) {
        userMap.set(String(issue.assigned_to.id), issue.assigned_to.name);
      }
    });
    const select = document.getElementById('filter-assignee');
    select.innerHTML = '<option value="">Responsável</option>';
    const sorted = [...userMap.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    sorted.forEach(([id, name]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      select.appendChild(opt);
    });
  } catch (e) {
    // Não-crítico
  }
}

// Calcular estatísticas localmente a partir de um conjunto de issues (usado quando estatísticas do servidor não estão disponíveis)
function updateStatsFromIssues(issues) {
  let overdue = 0;
  let dueSoon = 0;
  let highPriority = 0;
  issues.forEach(issue => {
    if (issue.due_date) {
      const days = daysUntilDue(issue.due_date);
      if (days < 0) overdue++;
      else if (days <= 3) dueSoon++;
    }
    if (issue.priority && issue.priority.id >= 3) highPriority++;
  });
  document.getElementById('overdue-count').textContent = overdue;
  document.getElementById('due-soon-count').textContent = dueSoon;
  document.getElementById('high-count').textContent = highPriority;
}

function updatePaginator() {
  const paginator = document.getElementById('paginator');
  const totalPages = Math.ceil(generalTotalCount / generalLimit);

  if (totalPages <= 1) {
    paginator.classList.add('hidden');
    return;
  }

  paginator.classList.remove('hidden');
  document.getElementById('page-info').textContent = `${generalPage + 1} / ${totalPages}`;
  document.getElementById('btn-prev').disabled = generalPage === 0;
  document.getElementById('btn-next').disabled = generalPage >= totalPages - 1;
}

//Utilitários

function daysUntilDue(dateStr) {
  const due = new Date(dateStr + 'T23:59:59');
  const now = new Date();
  return Math.ceil((due - now) / (1000 * 60 * 60 * 24));
}

function isOverdue(issue) {
  if (!issue.due_date) return false;
  return daysUntilDue(issue.due_date) < 0;
}

function getPriorityClass(priority) {
  if (!priority) return 'priority-normal';
  const id = priority.id;
  if (id >= 5) return 'priority-urgent';
  if (id >= 4) return 'priority-high';
  if (id >= 3) return 'priority-normal';
  return 'priority-low';
}

function getPriorityLabel(priority) {
  if (!priority) return 'normal';
  const id = priority.id;
  if (id >= 5) return 'urgent';
  if (id >= 4) return 'high';
  if (id >= 3) return 'normal';
  return 'low';
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showSection(id) {
  hideAll();
  document.getElementById(id).classList.remove('hidden');
}

function showError(msg) {
  hideAll();
  const { text, hint } = friendlyError(msg);
  document.getElementById('error-text').textContent = text;
  const hintEl = document.getElementById('error-hint');
  if (hint) {
    hintEl.textContent = hint;
    hintEl.classList.remove('hidden');
  } else {
    hintEl.classList.add('hidden');
  }
  document.getElementById('error').classList.remove('hidden');
}

function friendlyError(msg) {
  if (!msg) return { text: 'Erro desconhecido.' };
  const lower = msg.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network request failed')) {
    return {
      text: '⛔ Sem conexão com o Redmine',
      hint: 'Possíveis causas: VPN desconectada, sem internet, servidor fora do ar ou URL incorreta nas configurações.'
    };
  }
  if (lower.includes('timeout') || lower.includes('aborted')) {
    return {
      text: '⏱️ Tempo de conexão esgotado',
      hint: 'O servidor demorou para responder. Verifique sua conexão ou tente novamente.'
    };
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return {
      text: '🔑 Autenticação falhou',
      hint: 'A API Key pode estar inválida ou expirada. Verifique nas configurações.'
    };
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return {
      text: '🚫 Acesso negado',
      hint: 'Você não tem permissão para acessar este recurso no Redmine.'
    };
  }
  if (lower.includes('404')) {
    return {
      text: '❌ Recurso não encontrado',
      hint: 'Verifique se a URL do Redmine está correta nas configurações.'
    };
  }
  return { text: msg };
}

function hideAll() {
  ['not-configured', 'loading', 'error', 'summary', 'issues-list', 'empty', 'filters-bar', 'paginator'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
}
