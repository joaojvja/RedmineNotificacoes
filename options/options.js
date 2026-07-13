document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadTrackers();
});

document.getElementById('settings-form').addEventListener('submit', saveSettings);
document.getElementById('btn-test').addEventListener('click', testConnection);

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    redmineUrl: '',
    apiKey: '',
    checkInterval: 5,
    deadlineWarningDays: 3,
    notifyDeadlines: true,
    notifyStatus: true,
    notifyPriority: true,
    notifyComments: true,
    notifyNewAssignment: true,
    filterGroups: false,
    excludeTrackers: []
  });

  document.getElementById('redmine-url').value = settings.redmineUrl;
  document.getElementById('api-key').value = settings.apiKey;
  document.getElementById('check-interval').value = settings.checkInterval;
  document.getElementById('deadline-days').value = settings.deadlineWarningDays;
  document.getElementById('notify-deadlines').checked = settings.notifyDeadlines;
  document.getElementById('notify-status').checked = settings.notifyStatus;
  document.getElementById('notify-priority').checked = settings.notifyPriority;
  document.getElementById('notify-comments').checked = settings.notifyComments;
  document.getElementById('notify-assignment').checked = settings.notifyNewAssignment;
  document.getElementById('filter-groups').checked = settings.filterGroups;
}

async function saveSettings(e) {
  e.preventDefault();

  const rawUrl = document.getElementById('redmine-url').value.trim().replace(/\/$/, '');

  // Validar esquema da URL — permitir apenas http(s)
  if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
    showSaveStatus('❌ A URL deve começar com http:// ou https://');
    return;
  }

  // Solicitar permissão de host para o domínio do Redmine
  if (rawUrl) {
    const hostPattern = new URL(rawUrl).origin + '/*';
    const granted = await chrome.permissions.request({ origins: [hostPattern] });
    if (!granted) {
      showSaveStatus('❌ Permissão de acesso ao servidor negada. A extensão precisa dessa permissão para funcionar.');
      return;
    }
  }

  // Coletar trackers excluídos
  const excludeTrackers = [...document.querySelectorAll('#exclude-trackers-list input[type="checkbox"]:checked')]
    .map(cb => parseInt(cb.value));

  const settings = {
    redmineUrl: rawUrl,
    apiKey: document.getElementById('api-key').value.trim(),
    checkInterval: parseInt(document.getElementById('check-interval').value) || 5,
    deadlineWarningDays: parseInt(document.getElementById('deadline-days').value) || 3,
    notifyDeadlines: document.getElementById('notify-deadlines').checked,
    notifyStatus: document.getElementById('notify-status').checked,
    notifyPriority: document.getElementById('notify-priority').checked,
    notifyComments: document.getElementById('notify-comments').checked,
    notifyNewAssignment: document.getElementById('notify-assignment').checked,
    filterGroups: document.getElementById('filter-groups').checked,
    excludeTrackers: excludeTrackers
  };

  await chrome.storage.sync.set(settings);

  showSaveStatus('✅ Configurações salvas com sucesso!');
}

async function testConnection() {
  const url = document.getElementById('redmine-url').value.trim().replace(/\/$/, '');
  const apiKey = document.getElementById('api-key').value.trim();
  const resultEl = document.getElementById('test-result');

  if (!url || !apiKey) {
    showTestResult('Preencha a URL e API Key antes de testar.', false);
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    showTestResult('❌ A URL deve começar com http:// ou https://', false);
    return;
  }

  // Solicitar permissão de host para o domínio do Redmine
  const hostPattern = new URL(url).origin + '/*';
  const granted = await chrome.permissions.request({ origins: [hostPattern] });
  if (!granted) {
    showTestResult('❌ Permissão de acesso ao servidor negada.', false);
    return;
  }

  resultEl.textContent = 'Testando...';
  resultEl.className = 'test-result';

  try {
    const response = await fetch(`${url}/users/current.json`, {
      headers: {
        'X-Redmine-API-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        showTestResult('❌ API Key inválida. Verifique sua chave.', false);
      } else {
        showTestResult(`❌ Erro ${response.status}: ${response.statusText}`, false);
      }
      return;
    }

    const data = await response.json();
    const user = data.user;
    showTestResult(`✅ Conectado! Olá, ${user.firstname} ${user.lastname} (${user.login})`, true);
  } catch (error) {
    const msg = error.message || '';
    if (msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('networkerror')) {
      showTestResult('⛔ Sem conexão — Verifique: VPN ativa? Internet funcionando? URL correta?', false);
    } else {
      showTestResult(`❌ Não foi possível conectar: ${msg}`, false);
    }
  }
}

function showTestResult(message, success) {
  const el = document.getElementById('test-result');
  el.textContent = message;
  el.className = `test-result ${success ? 'success' : 'error'}`;
}

function showSaveStatus(message) {
  const el = document.getElementById('save-status');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

async function loadTrackers() {
  const settings = await chrome.storage.sync.get({ redmineUrl: '', apiKey: '', excludeTrackers: [] });
  const url = settings.redmineUrl;
  const apiKey = settings.apiKey;
  const container = document.getElementById('exclude-trackers-list');

  if (!url || !apiKey) return;

  try {
    const response = await fetch(`${url}/trackers.json`, {
      headers: { 'X-Redmine-API-Key': apiKey, 'Content-Type': 'application/json' }
    });

    if (!response.ok) return;

    const data = await response.json();
    const trackers = (data.trackers || []).sort((a, b) => a.name.localeCompare(b.name));

    if (trackers.length === 0) return;

    container.innerHTML = '';
    trackers.forEach(tracker => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = tracker.id;
      cb.checked = settings.excludeTrackers.includes(tracker.id);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(` ${tracker.name}`));
      container.appendChild(label);
    });
  } catch (e) {
    // Falha silenciosa — o usuário pode não ter conectado ainda
  }
}
