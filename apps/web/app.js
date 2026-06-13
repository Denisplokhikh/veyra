const state = {
  profile: null,
  yaml: '',
  saveUrl: '',
  runtimeStatus: null,
  configs: [],
  activeConfigId: null,
  configStatuses: new Map(),
  expandedConfigIds: new Set()
};

const TWEMOJI_BASE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/';

const elements = {
  layout: document.querySelector('.layout'),
  profileName: document.querySelector('#profileName'),
  nodeCount: document.querySelector('#nodeCount'),
  ruleCount: document.querySelector('#ruleCount'),
  groupCount: document.querySelector('#groupCount'),
  importText: document.querySelector('#importText'),
  importErrors: document.querySelector('#importErrors'),
  pasteImportBtn: document.querySelector('#pasteImportBtn'),
  importBtn: document.querySelector('#importBtn'),
  pingNodesBtn: document.querySelector('#pingNodesBtn'),
  addNodeBtn: document.querySelector('#addNodeBtn'),
  nodesList: document.querySelector('#nodesList'),
  nodeTemplate: document.querySelector('#nodeTemplate'),
  loadSample: document.querySelector('#loadSample'),
  yamlPreview: document.querySelector('#yamlPreview'),
  warnings: document.querySelector('#warnings'),
  copyBtn: document.querySelector('#copyBtn'),
  savedProfiles: document.querySelector('#savedProfiles'),
  runtimeToggle: document.querySelector('#runtimeToggle'),
  runtimeToggleText: document.querySelector('#runtimeToggleText'),
  runtimeState: document.querySelector('#runtimeState'),
  selectedRuntimeServer: document.querySelector('#selectedRuntimeServer'),
  runtimeBinary: document.querySelector('#runtimeBinary'),
  runtimeLogs: document.querySelector('#runtimeLogs'),
  tabButtons: Array.from(document.querySelectorAll('[data-tab]')),
  tabPanels: Array.from(document.querySelectorAll('[data-tab-panel]')),
  tabPreviews: Array.from(document.querySelectorAll('[data-tab-preview]')),
  modeButtons: Array.from(document.querySelectorAll('[data-mode]')),
  mixedPort: document.querySelector('#mixedPort'),
  socksPort: document.querySelector('#socksPort'),
  externalController: document.querySelector('#externalController'),
  logLevel: document.querySelector('#logLevel'),
  allowLan: document.querySelector('#allowLan'),
  ipv6: document.querySelector('#ipv6'),
  tunEnabled: document.querySelector('#tunEnabled'),
  tunStack: document.querySelector('#tunStack'),
  dnsHijack: document.querySelector('#dnsHijack'),
  autoRoute: document.querySelector('#autoRoute'),
  strictRoute: document.querySelector('#strictRoute'),
  dnsEnabled: document.querySelector('#dnsEnabled'),
  enhancedMode: document.querySelector('#enhancedMode'),
  dnsListen: document.querySelector('#dnsListen'),
  nameservers: document.querySelector('#nameservers'),
  fallbackDns: document.querySelector('#fallbackDns'),
  groupAuto: document.querySelector('#groupAuto'),
  groupFallback: document.querySelector('#groupFallback'),
  groupLoadBalance: document.querySelector('#groupLoadBalance'),
  testUrl: document.querySelector('#testUrl'),
  interval: document.querySelector('#interval'),
  bypassPrivate: document.querySelector('#bypassPrivate'),
  blockAds: document.querySelector('#blockAds'),
  customRules: document.querySelector('#customRules')
};

let generateTimer = 0;
let stateSaveTimer = 0;
let isHydrating = true;
let runtimeBusy = false;
let runtimeBusyMode = '';
let tcpPingBusy = false;
const tcpPingResults = new Map();

init();

async function init() {
  bindEvents();
  await loadInitialProfile();
  enforceSingleSelectedServer();
  render();
  isHydrating = false;
  await generate();
  await renderSavedConfigs();
  await loadRuntimeStatus();
  window.setInterval(loadRuntimeStatus, 5000);
}

function bindEvents() {
  elements.generateBtn?.addEventListener('click', generate);
  elements.loadSample.addEventListener('click', loadSample);
  elements.pasteImportBtn.addEventListener('click', pasteImportText);
  elements.importBtn.addEventListener('click', importLinks);
  elements.pingNodesBtn.addEventListener('click', pingTcpServers);
  elements.importText.addEventListener('input', scheduleStateSave);
  elements.copyBtn.addEventListener('click', copyYaml);
  elements.runtimeToggle.addEventListener('click', toggleRuntime);

  elements.addNodeBtn?.addEventListener('click', () => {
    state.profile.nodes.push(createEmptyNode());
    enforceSingleSelectedServer();
    renderNodes();
    scheduleGenerate();
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  elements.modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      state.profile.mode = button.dataset.mode;
      renderMode();
      scheduleGenerate();
      scheduleStateSave();
    });
  });

  [
    elements.profileName,
    elements.mixedPort,
    elements.socksPort,
    elements.externalController,
    elements.logLevel,
    elements.allowLan,
    elements.ipv6,
    elements.tunEnabled,
    elements.tunStack,
    elements.dnsHijack,
    elements.autoRoute,
    elements.strictRoute,
    elements.dnsEnabled,
    elements.enhancedMode,
    elements.dnsListen,
    elements.nameservers,
    elements.fallbackDns,
    elements.groupAuto,
    elements.groupFallback,
    elements.groupLoadBalance,
    elements.testUrl,
    elements.interval,
    elements.bypassPrivate,
    elements.blockAds,
    elements.customRules
  ].forEach((element) => {
    if (!element) return;

    element.addEventListener('input', () => {
      updateProfileFromForm();
      scheduleGenerate();
      scheduleStateSave();
    });
  });

  window.addEventListener('beforeunload', persistStateOnUnload);
}

async function loadInitialProfile() {
  const sample = withTunEnabled(await request('/api/sample'));

  try {
    const saved = await request('/api/state');
    state.configs = normalizeSavedConfigs(saved.configs);
    state.activeConfigId = saved.activeConfigId || state.configs[0]?.id || null;
    state.profile = withTunEnabled(saved.profile || sample);
    elements.importText.value = saved.importText || '';

    if (state.configs.length) {
      const activeConfig = getActiveConfig() || state.configs[0];
      state.activeConfigId = activeConfig.id;
      state.expandedConfigIds.add(activeConfig.id);
      applyConfigToProfile(activeConfig);
    } else if (state.profile.nodes?.length) {
      const migrated = createSavedConfig({
        name: state.profile.name || 'Импортированный конфиг',
        sourceType: 'legacy',
        importText: saved.importText || '',
        nodes: state.profile.nodes.map((node) => ({ ...node, enabled: undefined })),
        selectedIndex: Math.max(0, state.profile.nodes.findIndex((node) => node.enabled !== false))
      });
      state.configs = [migrated];
      state.activeConfigId = migrated.id;
      state.expandedConfigIds.add(migrated.id);
      applyConfigToProfile(migrated);
    }

    if (state.profile) {
      return;
    }
  } catch {
    // Fall back to the sample profile if persisted state is unavailable.
  }

  state.profile = sample;
}

async function loadSample() {
  state.profile = withTunEnabled(await request('/api/sample'));
  state.profile.name = 'Mihomo VLESS Profile';
  state.profile.nodes = [];
  state.configs = [];
  state.activeConfigId = null;
  tcpPingResults.clear();
  elements.importText.value = '';
  render();
  await generate();
  await saveAppState();
}

async function pasteImportText() {
  elements.pasteImportBtn.disabled = true;

  try {
    if (!navigator.clipboard?.readText) {
      throw new Error('Буфер обмена недоступен в этом режиме запуска.');
    }

    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      renderImportErrors([{ message: 'Буфер обмена пуст.' }]);
      return;
    }

    elements.importText.value = text.trim();
    elements.importText.focus();
    renderImportErrors([]);
    scheduleStateSave();
  } catch (error) {
    renderImportErrors([{ message: `Не получилось вставить из буфера: ${error.message}` }]);
  } finally {
    elements.pasteImportBtn.disabled = false;
  }
}

async function importLinks() {
  elements.importBtn.disabled = true;

  try {
    const input = elements.importText.value.trim();
    const imported = await request('/api/import', {
      method: 'POST',
      body: { text: input }
    });

    if (imported.nodes.length) {
      const config = upsertImportedConfig(imported, input);
      state.activeConfigId = config.id;
      applyConfigToProfile(config);
      tcpPingResults.clear();
      render();
      await generate();
      await saveAppState();
    }

    renderImportErrors(imported.errors);
  } catch (error) {
    renderImportErrors([{ message: error.message }]);
  } finally {
    elements.importBtn.disabled = false;
  }
}

async function pingTcpServers() {
  const nodes = (state.profile?.nodes || []).filter((node) => node.server && node.port);
  await pingNodesByTcp(nodes);
}

async function pingConfigServers(configId) {
  const config = state.configs.find((item) => item.id === configId);
  const nodes = (config?.nodes || []).filter((node) => node.server && node.port);
  await pingNodesByTcp(nodes);
}

async function pingNodesByTcp(nodes) {
  if (!nodes.length || tcpPingBusy) return;

  tcpPingBusy = true;
  renderPingViews();

  nodes.forEach((node) => {
    tcpPingResults.set(getNodePingKey(node), { status: 'pending' });
  });
  renderPingViews();

  try {
    const data = await request('/api/ping/tcp', {
      method: 'POST',
      body: {
        timeoutMs: 4000,
        nodes: nodes.map((node) => ({
          pingKey: getNodePingKey(node),
          name: node.name,
          server: node.server,
          port: node.port
        }))
      }
    });

    data.results.forEach((result) => {
      tcpPingResults.set(result.pingKey, {
        status: result.ok ? 'ok' : 'error',
        latencyMs: result.latencyMs,
        error: result.error
      });
    });
  } catch (error) {
    nodes.forEach((node) => {
      tcpPingResults.set(getNodePingKey(node), {
        status: 'error',
        error: error.message
      });
    });
  } finally {
    tcpPingBusy = false;
    renderPingViews();
  }
}

function renderPingViews() {
  renderPingButton();
  renderNodes();
  renderSavedConfigs();
}

async function generate() {
  updateProfileFromForm();
  enforceSingleSelectedServer();
  if (elements.generateBtn) elements.generateBtn.disabled = true;

  try {
    const generated = await request('/api/generate', {
      method: 'POST',
      body: state.profile
    });
    state.yaml = generated.yaml;
    elements.yamlPreview.textContent = generated.yaml;
    renderWarnings(generated.warnings);
    renderSummary(generated.summary);
  } finally {
    if (elements.generateBtn) elements.generateBtn.disabled = false;
  }
}

async function loadProfiles() {
  const data = await request('/api/profiles');
  elements.savedProfiles.innerHTML = '';

  if (!data.profiles.length) {
    elements.savedProfiles.innerHTML = '<div class="notice">Пока нет сохраненных профилей.</div>';
    return;
  }

  data.profiles.forEach((profile) => {
    const item = document.createElement('div');
    item.className = 'saved-item';
    item.innerHTML = `
  <div>
    <strong>${escapeHtml(profile.summary?.name || profile.id)}</strong>
    <small>${escapeHtml(formatDate(profile.createdAt))} · ${profile.summary?.nodes || 0} сервер</small>
  </div>
  <div class="saved-actions">
    <a class="secondary" href="${profile.downloadUrl}">YAML</a>
    <button class="danger-button" type="button" data-delete-profile="${escapeHtml(profile.id)}">Удалить</button>
  </div>
    `;
    item
  .querySelector('[data-delete-profile]')
  .addEventListener('click', () => deleteProfile(profile.id));
    elements.savedProfiles.append(item);
  });
}

async function deleteProfile(id) {
  const ok = window.confirm('Удалить сохраненный профиль?');
  if (!ok) return;

  await request(`/api/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: {}
  });

  await loadProfiles();
}

async function renderSavedConfigs() {
  elements.savedProfiles.innerHTML = '';

  if (!state.configs.length) {
    elements.savedProfiles.innerHTML = '<div class="notice">Пока нет сохраненных конфигов. Импортируй подписку, и она появится здесь автоматически.</div>';
    return;
  }

  state.configs.forEach((config) => {
    elements.savedProfiles.append(createSavedConfigCard(config));
  });
}

function createSavedConfigCard(config) {
  const selectedIndex = getConfigSelectedIndex(config);
  const expanded = state.expandedConfigIds.has(config.id);
  const status = state.configStatuses.get(config.id);
  const item = document.createElement('article');
  item.className = `saved-item config-card${config.id === state.activeConfigId ? ' selected' : ''}${expanded ? ' expanded' : ''}`;
  item.dataset.configId = config.id;

  const header = document.createElement('div');
  header.className = 'config-header';

  const toggle = document.createElement('button');
  toggle.className = 'config-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.addEventListener('click', () => toggleSavedConfig(config.id));

  const heading = document.createElement('span');
  heading.className = 'config-heading';

  const title = document.createElement('strong');
  renderEmojiText(title, config.name || 'VPN конфиг');

  const meta = document.createElement('small');
  meta.textContent = `${formatDate(config.updatedAt || config.createdAt)} · ${config.nodes.length} сервер${getRussianPlural(config.nodes.length, '', 'а', 'ов')}`;

  heading.append(title, meta);
  toggle.append(heading);

  const actions = document.createElement('div');
  actions.className = 'saved-actions';

  const updateButton = document.createElement('button');
  updateButton.className = 'secondary';
  updateButton.type = 'button';
  updateButton.textContent = 'Обновить';
  updateButton.addEventListener('click', () => updateSavedConfig(config.id));

  const removeButton = document.createElement('button');
  removeButton.className = 'danger-button';
  removeButton.type = 'button';
  removeButton.textContent = 'Удалить';
  removeButton.addEventListener('click', () => removeSavedConfig(config.id));

  actions.append(updateButton, removeButton);
  header.append(toggle, actions);
  item.append(header);

  if (status) {
    const statusNode = document.createElement('small');
    statusNode.className = `config-status ${status.type}`;
    statusNode.textContent = status.message;
    item.append(statusNode);
  }

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'config-body-wrap';
  bodyWrap.setAttribute('aria-hidden', String(!expanded));
  bodyWrap.inert = !expanded;
  bodyWrap.append(createSavedConfigServerPanel(config, selectedIndex));
  item.append(bodyWrap);

  return item;
}

function createSavedConfigServerPanel(config, selectedIndex) {
  const body = document.createElement('div');
  body.className = 'config-body';

  const top = document.createElement('div');
  top.className = 'config-servers-title';

  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Серверы';
  const caption = document.createElement('p');
  caption.textContent = 'Выбери один сервер из импортированной подписки. Детали конфига скрыты.';
  copy.append(title, caption);

  const pingButton = document.createElement('button');
  pingButton.className = 'secondary config-ping-button';
  pingButton.type = 'button';
  pingButton.textContent = tcpPingBusy ? 'Пингуем...' : 'Пинг';
  pingButton.disabled = tcpPingBusy || !config.nodes.some((node) => node.server && node.port);
  pingButton.addEventListener('click', () => pingConfigServers(config.id));

  top.append(copy, pingButton);
  body.append(top);

  const list = document.createElement('div');
  list.className = 'nodes-list config-server-list';

  config.nodes.forEach((node, index) => {
    list.append(createSavedConfigServerCard(config, node, index, selectedIndex));
  });

  body.append(list);
  return body;
}

function createSavedConfigServerCard(config, node, index, selectedIndex) {
  const card = document.createElement('article');
  card.className = `node-card config-server-card${index === selectedIndex ? ' selected' : ''}`;

  const label = document.createElement('label');
  label.className = 'server-option';

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = `config-server-${config.id}`;
  input.checked = index === selectedIndex;
  input.addEventListener('change', () => selectConfigServer(config.id, index));

  const copy = document.createElement('span');
  copy.className = 'server-copy';

  const title = document.createElement('strong');
  renderEmojiText(title, node.name || `Сервер ${index + 1}`);

  const meta = document.createElement('small');
  meta.textContent = getNodeMeta(node);

  const latency = document.createElement('span');
  renderNodeLatency(latency, node);

  copy.append(title, meta);
  label.append(input, copy, latency);
  card.append(label);
  return card;
}

function toggleSavedConfig(id) {
  const wasExpanded = state.expandedConfigIds.has(id);

  if (wasExpanded) {
    state.expandedConfigIds.delete(id);
  } else {
    state.expandedConfigIds.add(id);
  }

  const expanded = !wasExpanded;
  const card = Array.from(elements.savedProfiles.querySelectorAll('.config-card'))
    .find((item) => item.dataset.configId === id);

  if (!card) {
    renderSavedConfigs();
    return;
  }

  card.classList.toggle('expanded', expanded);
  card.querySelector('.config-toggle')?.setAttribute('aria-expanded', String(expanded));

  const bodyWrap = card.querySelector('.config-body-wrap');
  if (bodyWrap) {
    bodyWrap.setAttribute('aria-hidden', String(!expanded));
    bodyWrap.inert = !expanded;
  }
}

async function removeSavedConfig(id) {
  const ok = window.confirm('Удалить сохраненный конфиг?');
  if (!ok) return;

  const removedIndex = state.configs.findIndex((config) => config.id === id);
  state.configs = state.configs.filter((config) => config.id !== id);
  state.configStatuses.delete(id);
  state.expandedConfigIds.delete(id);

  if (state.activeConfigId === id) {
    const nextConfig = state.configs[Math.max(0, removedIndex - 1)] || state.configs[0] || null;
    state.activeConfigId = nextConfig?.id || null;

    if (nextConfig) {
      applyConfigToProfile(nextConfig);
    } else {
      state.profile.nodes = [];
      state.profile.name = 'Mihomo VLESS Profile';
      tcpPingResults.clear();
    }
  }

  await renderSavedConfigs();
  render();
  await generate();
  await saveAppState();
}

async function updateSavedConfig(id) {
  const config = state.configs.find((item) => item.id === id);
  if (!config) return;

  const source = config.sourceUrl || config.importText;
  if (!source) {
    state.configStatuses.set(id, { type: 'error', message: 'Нет ссылки для обновления.' });
    await renderSavedConfigs();
    return;
  }

  state.configStatuses.set(id, { type: 'pending', message: 'Обновляем подписку...' });
  await renderSavedConfigs();

  try {
    const imported = await request('/api/import', {
      method: 'POST',
      body: { text: source }
    });

    if (!imported.nodes.length) {
      state.configStatuses.set(id, { type: 'error', message: 'Провайдер не вернул серверы.' });
      await renderSavedConfigs();
      return;
    }

    const previousKeys = config.nodes.map(getNodeStableKey).join('\n');
    const previousSelected = config.nodes[getConfigSelectedIndex(config)];
    config.nodes = imported.nodes.map((node) => ({ ...toUiNode(node), enabled: undefined }));
    config.name = imported.profile?.title || config.name;
    config.sourceType = imported.source || config.sourceType;
    config.sourceUrl = imported.url || config.sourceUrl;
    config.profileMeta = imported.profile || config.profileMeta || null;
    config.updatedAt = new Date().toISOString();
    config.selectedIndex = findMatchingNodeIndex(config.nodes, previousSelected);

    if (state.activeConfigId === id) {
      applyConfigToProfile(config);
      render();
      await generate();
    }

    const nextKeys = config.nodes.map(getNodeStableKey).join('\n');
    state.configStatuses.set(id, {
      type: 'ok',
      message: previousKeys === nextKeys
        ? 'Изменений у провайдера нет.'
        : `Обновлено: ${config.nodes.length} сервер${getRussianPlural(config.nodes.length, '', 'а', 'ов')}.`
    });
    await renderSavedConfigs();
    await saveAppState();
  } catch (error) {
    state.configStatuses.set(id, { type: 'error', message: error.message });
    await renderSavedConfigs();
  }
}

async function toggleRuntime() {
  if (state.runtimeStatus?.running) {
    await stopRuntime();
  } else {
    await startRuntime();
  }
}

async function startRuntime() {
  updateProfileFromForm();
  enforceSingleSelectedServer();
  setRuntimeToggleBusy(true, 'start');

  try {
    const status = await request('/api/runtime/start', {
      method: 'POST',
      body: state.profile
    });
    renderRuntimeStatus(status);
    await loadRuntimeLogs();
  } catch (error) {
    renderRuntimeStatus({ error: error.message, binary: error.payload?.binary });
  } finally {
    setRuntimeToggleBusy(false);
  }
}

async function stopRuntime() {
  setRuntimeToggleBusy(true, 'stop');

  try {
    renderRuntimeStatus(await request('/api/runtime/stop', { method: 'POST', body: {} }));
    await loadRuntimeLogs();
  } finally {
    setRuntimeToggleBusy(false);
  }
}

async function loadRuntimeStatus() {
  const status = await request('/api/runtime/status');
  renderRuntimeStatus(status);
  await loadRuntimeLogs();
}

async function loadRuntimeLogs() {
  const logs = await request('/api/runtime/logs');
  elements.runtimeLogs.textContent = logs.text || 'Логов пока нет.';
}

function render() {
  elements.profileName.value = state.profile.name || '';
  elements.mixedPort.value = state.profile.mixedPort || 7890;
  elements.socksPort.value = state.profile.socksPort || 7891;
  elements.externalController.value = state.profile.externalController || '127.0.0.1:9090';
  elements.logLevel.value = state.profile.logLevel || 'info';
  elements.allowLan.checked = Boolean(state.profile.allowLan);
  elements.ipv6.checked = Boolean(state.profile.ipv6);

  elements.tunEnabled.checked = Boolean(state.profile.tun?.enabled);
  elements.tunStack.value = state.profile.tun?.stack || 'mixed';
  elements.dnsHijack.value = joinLines(state.profile.tun?.dnsHijack || ['any:53']);
  elements.autoRoute.checked = state.profile.tun?.autoRoute !== false;
  elements.strictRoute.checked = Boolean(state.profile.tun?.strictRoute);

  elements.dnsEnabled.checked = state.profile.dns?.enabled !== false;
  elements.enhancedMode.value = state.profile.dns?.enhancedMode || 'fake-ip';
  elements.dnsListen.value = state.profile.dns?.listen || '0.0.0.0:1053';
  elements.nameservers.value = joinLines(state.profile.dns?.nameservers || []);
  elements.fallbackDns.value = joinLines(state.profile.dns?.fallback || []);

  elements.groupAuto.checked = state.profile.groups?.auto !== false;
  elements.groupFallback.checked = state.profile.groups?.fallback !== false;
  elements.groupLoadBalance.checked = Boolean(state.profile.groups?.loadBalance);
  elements.testUrl.value = state.profile.groups?.testUrl || 'http://www.gstatic.com/generate_204';
  elements.interval.value = state.profile.groups?.interval || 300;

  elements.bypassPrivate.checked = state.profile.rules?.bypassPrivate !== false;
  elements.blockAds.checked = Boolean(state.profile.rules?.blockAds);
  elements.customRules.value = joinLines(state.profile.rules?.custom || []);

  renderMode();
  renderNodes();
  renderSavedConfigs();
}

function renderNodes() {
  elements.nodesList.innerHTML = '';
  enforceSingleSelectedServer();

  if (!state.profile.nodes.length) {
    elements.nodesList.innerHTML = '<div class="notice">Импортируй подписку, чтобы выбрать сервер.</div>';
    elements.nodeCount.textContent = '0';
    renderSelectedRuntimeServer();
    return;
  }

  state.profile.nodes.forEach((node, index) => {
    const fragment = elements.nodeTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.node-card');
    const input = card.querySelector('[data-field="enabled"]');
    const latency = card.querySelector('[data-node-latency]');

    renderEmojiText(card.querySelector('[data-server-name]'), node.name || `VLESS ${index + 1}`);
    input.checked = node.enabled !== false;
    input.addEventListener('change', () => selectServer(index));

    updateNodeCardState(card, node);
    renderNodeLatency(latency, node);
    elements.nodesList.append(fragment);
  });

  elements.nodeCount.textContent = String(countRealNodes());
  renderPingButton();
  renderSelectedRuntimeServer();
}

function renderPingButton() {
  if (!elements.pingNodesBtn) return;

  const hasNodes = Boolean(state.profile?.nodes?.some((node) => node.server && node.port));
  elements.pingNodesBtn.disabled = tcpPingBusy || !hasNodes;
  elements.pingNodesBtn.textContent = tcpPingBusy ? 'Пингуем...' : 'Пинг';
}

function renderNodeLatency(element, node) {
  if (!element) return;

  const result = tcpPingResults.get(getNodePingKey(node));
  element.className = 'server-latency';

  if (!result) {
    element.textContent = '—';
    return;
  }

  if (result.status === 'pending') {
    element.classList.add('pending');
    element.textContent = '...';
    return;
  }

  if (result.status === 'ok') {
    element.classList.add('ok');
    element.textContent = `${result.latencyMs} ms`;
    return;
  }

  element.classList.add('bad');
  element.textContent = result.error === 'Timeout' ? 'timeout' : 'error';
  element.title = result.error || '';
}

function renderSelectedRuntimeServer() {
  const selected = getSelectedNode();
  renderEmojiText(elements.selectedRuntimeServer, selected?.name || 'Сервер не выбран');
  renderRuntimeControls();
}

function switchTab(tab) {
  elements.tabButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  elements.tabPanels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tabPanel !== tab);
  });
  elements.tabPreviews.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tabPreview !== tab);
  });
  elements.layout.classList.toggle('preview-hidden', tab !== 'settings');
}

function updateNodeCardState(card, node) {
  card.classList.toggle('selected', node.enabled !== false);
  card.classList.toggle('disabled', node.enabled === false);

  const meta = card.querySelector('[data-node-meta]');
  if (!meta) return;

  meta.textContent = getNodeMeta(node);
}

function getNodeMeta(node) {
  const bits = [
    'VLESS',
    (node.network || 'tcp').toUpperCase(),
    node.tls !== false ? 'TLS' : 'NO TLS',
    node.flow ? 'VISION' : '',
    node.packetEncoding || node['packet-encoding'] || ''
  ].filter(Boolean);

  return bits.join(' · ');
}

function renderMode() {
  elements.modeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.profile.mode);
  });
}

function renderSummary(summary) {
  elements.nodeCount.textContent = String(summary.nodes);
  elements.groupCount.textContent = String(summary.groups);
  elements.ruleCount.textContent = String(summary.rules);
}

function renderWarnings(warnings = []) {
  if (!warnings.length) {
    elements.warnings.classList.add('hidden');
    elements.warnings.textContent = '';
    return;
  }

  elements.warnings.classList.remove('hidden');
  elements.warnings.innerHTML = warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('');
}

function renderRuntimeStatus(status) {
  state.runtimeStatus = status;

  if (status.error) {
    elements.runtimeState.textContent = status.error;
  } else if (status.running) {
    elements.runtimeState.textContent = `Подключено, PID ${status.pid}`;
  } else {
    elements.runtimeState.textContent = status.lastExit ? 'Отключено' : 'Не подключено';
  }

  const binaryText = status.binary || 'engine/bin/mihomo.exe';
  elements.runtimeBinary.textContent = status.binaryExists === false ? `Не найден: ${binaryText}` : binaryText;
  renderRuntimeControls();
}

function renderRuntimeControls() {
  const running = Boolean(state.runtimeStatus?.running);
  const hasServer = Boolean(getSelectedNode());

  elements.runtimeToggle.classList.toggle('connected', running);
  elements.runtimeToggle.setAttribute('aria-pressed', String(running));
  elements.runtimeToggle.disabled = runtimeBusy || (!running && !hasServer);

  if (runtimeBusy) {
    elements.runtimeToggleText.textContent = runtimeBusyMode === 'stop' ? 'Отключение...' : 'Подключение...';
  } else {
    elements.runtimeToggleText.textContent = running ? 'Отключить' : 'Подключить';
  }
}

function setRuntimeToggleBusy(busy, mode = '') {
  runtimeBusy = busy;
  runtimeBusyMode = busy ? mode : '';
  renderRuntimeControls();
}

function renderImportErrors(errors = []) {
  if (!errors.length) {
    elements.importErrors.classList.add('hidden');
    elements.importErrors.textContent = '';
    return;
  }

  elements.importErrors.classList.remove('hidden');
  elements.importErrors.innerHTML = errors.map((error) => `<div>${escapeHtml(error.message)}</div>`).join('');
}

function updateProfileFromForm() {
  state.profile.name = elements.profileName.value.trim() || 'Mihomo VLESS Profile';
  state.profile.mixedPort = Number(elements.mixedPort.value) || 7890;
  state.profile.socksPort = Number(elements.socksPort.value) || 7891;
  state.profile.externalController = elements.externalController.value.trim() || '127.0.0.1:9090';
  state.profile.logLevel = elements.logLevel.value;
  state.profile.allowLan = elements.allowLan.checked;
  state.profile.ipv6 = elements.ipv6.checked;

  state.profile.tun = {
    enabled: elements.tunEnabled.checked,
    stack: elements.tunStack.value,
    dnsHijack: splitLines(elements.dnsHijack.value),
    autoRoute: elements.autoRoute.checked,
    strictRoute: elements.strictRoute.checked
  };

  state.profile.dns = {
    enabled: elements.dnsEnabled.checked,
    enhancedMode: elements.enhancedMode.value,
    listen: elements.dnsListen.value.trim(),
    nameservers: splitLines(elements.nameservers.value),
    fallback: splitLines(elements.fallbackDns.value)
  };

  state.profile.groups = {
    auto: elements.groupAuto.checked,
    fallback: elements.groupFallback.checked,
    loadBalance: elements.groupLoadBalance.checked,
    testUrl: elements.testUrl.value.trim(),
    interval: Number(elements.interval.value) || 300
  };

  state.profile.rules = {
    bypassPrivate: elements.bypassPrivate.checked,
    blockAds: elements.blockAds.checked,
    final: 'PROXY',
    custom: splitRuleLines(elements.customRules.value)
  };
}

function scheduleGenerate() {
  window.clearTimeout(generateTimer);
  generateTimer = window.setTimeout(generate, 300);
}

function scheduleStateSave() {
  if (isHydrating || !state.profile) return;

  window.clearTimeout(stateSaveTimer);
  stateSaveTimer = window.setTimeout(saveAppState, 450);
}

async function saveAppState() {
  if (isHydrating || !state.profile) return;

  window.clearTimeout(stateSaveTimer);

  try {
    updateProfileFromForm();
    enforceSingleSelectedServer();
    await request('/api/state', {
      method: 'POST',
      body: getAppStatePayload()
    });
  } catch (error) {
    console.warn('Could not persist app state', error);
  }
}

function persistStateOnUnload() {
  if (!state.profile) return;

  try {
    updateProfileFromForm();
    enforceSingleSelectedServer();
    const payload = JSON.stringify(getAppStatePayload());

    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/state', new Blob([payload], { type: 'application/json' }));
      return;
    }

    fetch('/api/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  } catch {
    // The regular debounced save already covers normal edits.
  }
}

function getAppStatePayload() {
  return {
    profile: state.profile,
    importText: elements.importText.value,
    configs: state.configs,
    activeConfigId: state.activeConfigId
  };
}

function upsertImportedConfig(imported, importText) {
  const existing = findExistingConfig(imported, importText);
  const now = new Date().toISOString();
  const nodes = imported.nodes.map((node) => ({ ...toUiNode(node), enabled: undefined }));
  const name = imported.profile?.title || existing?.name || getImportDisplayName(imported, importText);
  const previousSelected = existing ? existing.nodes[getConfigSelectedIndex(existing)] : null;
  const config = existing || createSavedConfig({ name, importText, nodes });

  config.name = name;
  config.sourceType = imported.source || 'text';
  config.sourceUrl = imported.url || (isRemoteUrl(importText) ? importText : '');
  config.importText = importText;
  config.userAgent = imported.userAgent || config.userAgent || '';
  config.profileMeta = imported.profile || config.profileMeta || null;
  config.nodes = nodes;
  config.updatedAt = now;
  config.selectedIndex = existing ? findMatchingNodeIndex(nodes, previousSelected) : 0;

  if (!existing) {
    state.configs.unshift(config);
  }

  state.expandedConfigIds.add(config.id);
  state.configStatuses.set(config.id, { type: 'ok', message: `Сохранено автоматически: ${nodes.length} сервер${getRussianPlural(nodes.length, '', 'а', 'ов')}.` });
  return config;
}

function findExistingConfig(imported, importText) {
  const sourceUrl = imported.url || (isRemoteUrl(importText) ? importText : '');
  if (sourceUrl) {
    return state.configs.find((config) => config.sourceUrl === sourceUrl);
  }
  return null;
}

function createSavedConfig({ name, sourceType = 'text', sourceUrl = '', importText = '', nodes = [], selectedIndex = 0 }) {
  const now = new Date().toISOString();
  return {
    id: makeConfigId(name || sourceUrl || importText || 'config'),
    name: name || 'VPN конфиг',
    sourceType,
    sourceUrl,
    importText,
    profileMeta: null,
    nodes,
    selectedIndex: Math.max(0, selectedIndex),
    createdAt: now,
    updatedAt: now
  };
}

function normalizeSavedConfigs(configs) {
  return (Array.isArray(configs) ? configs : [])
    .filter((config) => config && Array.isArray(config.nodes) && config.nodes.length)
    .map((config) => ({
      id: String(config.id || makeConfigId(config.name || 'config')),
      name: String(config.name || 'VPN конфиг'),
      sourceType: String(config.sourceType || 'text'),
      sourceUrl: String(config.sourceUrl || ''),
      importText: String(config.importText || ''),
      userAgent: String(config.userAgent || ''),
      profileMeta: config.profileMeta || null,
      nodes: config.nodes.map((node) => ({ ...toUiNode(node), enabled: undefined })),
      selectedIndex: clampIndex(config.selectedIndex, config.nodes.length),
      createdAt: config.createdAt || new Date().toISOString(),
      updatedAt: config.updatedAt || config.createdAt || new Date().toISOString()
    }));
}

function selectConfigServer(configId, selectedIndex) {
  const config = state.configs.find((item) => item.id === configId);
  if (!config) return;

  config.selectedIndex = clampIndex(selectedIndex, config.nodes.length);
  config.updatedAt = new Date().toISOString();
  state.activeConfigId = config.id;
  state.expandedConfigIds.add(config.id);
  applyConfigToProfile(config);
  render();
  scheduleGenerate();
  scheduleStateSave();
}

function applyConfigToProfile(config) {
  const selectedIndex = getConfigSelectedIndex(config);
  state.profile.name = config.name || state.profile.name || 'Mihomo VLESS Profile';
  state.profile.nodes = config.nodes.map((node, index) => ({
    ...node,
    enabled: index === selectedIndex
  }));
}

function getActiveConfig() {
  return state.configs.find((config) => config.id === state.activeConfigId) || null;
}

function getConfigSelectedIndex(config) {
  return clampIndex(config?.selectedIndex, config?.nodes?.length || 0);
}

function clampIndex(value, length) {
  if (!length) return 0;
  const index = Number(value);
  if (!Number.isFinite(index)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(index)));
}

function findMatchingNodeIndex(nodes, previousNode) {
  if (!nodes.length) return 0;
  if (!previousNode) return 0;

  const previousKey = getNodeStableKey(previousNode);
  const index = nodes.findIndex((node) => getNodeStableKey(node) === previousKey);
  return index === -1 ? 0 : index;
}

function getNodeStableKey(node) {
  return `${node?.uuid || ''}:${node?.server || ''}:${node?.port || ''}:${node?.name || ''}`;
}

function getImportDisplayName(imported, importText) {
  if (imported.url) {
    try {
      const url = new URL(imported.url);
      return url.hostname.replace(/^www\./, '') || 'VPN конфиг';
    } catch {
      return 'VPN конфиг';
    }
  }

  const firstNode = imported.nodes?.[0];
  return firstNode?.name || 'VPN конфиг';
}

function isRemoteUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function makeConfigId(value) {
  const slug = String(value || 'config')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'config';
  return `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getRussianPlural(number, one, few, many) {
  const mod10 = Math.abs(number) % 10;
  const mod100 = Math.abs(number) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function withTunEnabled(profile) {
  return {
    ...profile,
    tun: {
      stack: 'mixed',
      autoRoute: true,
      strictRoute: false,
      dnsHijack: ['any:53'],
      ...(profile?.tun || {}),
      enabled: true
    }
  };
}

function createEmptyNode() {
  return {
    enabled: true,
    name: `VLESS ${state.profile?.nodes?.length ? state.profile.nodes.length + 1 : 1}`,
    server: '',
    port: 443,
    uuid: '',
    network: 'tcp',
    servername: '',
    wsPath: '/',
    wsHost: '',
    clientFingerprint: 'chrome',
    packetEncoding: '',
    flow: '',
    publicKey: '',
    shortId: '',
    tls: true,
    udp: true,
    skipCertVerify: false
  };
}

function toUiNode(node, index) {
  return {
    enabled: index === 0,
    name: node.name || '',
    server: node.server || '',
    port: node.port || 443,
    uuid: node.uuid || '',
    network: node.network || 'tcp',
    servername: node.servername || '',
    wsPath: node['ws-opts']?.path || node.wsPath || '/',
    wsHost: node['ws-opts']?.headers?.Host || node.wsHost || '',
    clientFingerprint: node['client-fingerprint'] || node.clientFingerprint || '',
    packetEncoding: node['packet-encoding'] || node.packetEncoding || '',
    flow: node.flow || '',
    publicKey: node['reality-opts']?.['public-key'] || node.publicKey || '',
    shortId: node['reality-opts']?.['short-id'] || node.shortId || '',
    tls: node.tls !== false,
    udp: node.udp !== false,
    skipCertVerify: Boolean(node['skip-cert-verify'] || node.skipCertVerify)
  };
}

function countRealNodes() {
  return state.profile.nodes.filter((node) => node.enabled !== false && (node.server || node.uuid)).length;
}

function getSelectedNode() {
  return state.profile?.nodes?.find((node) => node.enabled !== false && (node.server || node.uuid));
}

function getNodePingKey(node) {
  return `${node.server || ''}:${node.port || ''}:${node.uuid || node.name || ''}`;
}

function selectServer(index) {
  state.profile.nodes = state.profile.nodes.map((node, nodeIndex) => ({
    ...node,
    enabled: nodeIndex === index
  }));
  renderNodes();
  scheduleGenerate();
  scheduleStateSave();
}

function enforceSingleSelectedServer() {
  if (!state.profile?.nodes?.length) return;

  const realNodes = state.profile.nodes.filter((node) => node.server || node.uuid);
  if (!realNodes.length) {
    state.profile.nodes = [];
    return;
  }

  let selectedIndex = realNodes.findIndex((node) => node.enabled !== false);
  if (selectedIndex === -1) selectedIndex = 0;

  state.profile.nodes = realNodes.map((node, index) => ({
    ...node,
    enabled: index === selectedIndex
  }));
}

async function copyYaml() {
  await navigator.clipboard.writeText(state.yaml || elements.yamlPreview.textContent);
  elements.copyBtn.textContent = 'Скопировано';
  window.setTimeout(() => {
    elements.copyBtn.textContent = 'Копировать';
  }, 1200);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.payload = payload;
    throw error;
  }

  return response.json();
}

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function splitRuleLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function joinLines(value) {
  return Array.isArray(value) ? value.join('\n') : '';
}

function renderEmojiText(target, value) {
  target.replaceChildren(...createEmojiTextNodes(value));
}

function createEmojiTextNodes(value) {
  const nodes = [];
  const chars = Array.from(String(value || ''));
  let text = '';

  const flushText = () => {
    if (!text) return;
    nodes.push(document.createTextNode(text));
    text = '';
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const codePoint = char.codePointAt(0);
    const nextCodePoint = chars[index + 1]?.codePointAt(0);

    if (isRegionalIndicator(codePoint) && isRegionalIndicator(nextCodePoint)) {
      const emoji = `${char}${chars[index + 1]}`;
      flushText();
      nodes.push(createEmojiImage(emoji));
      index += 1;
      continue;
    }

    if (isEmojiCodePoint(codePoint)) {
      let emoji = char;

      while (isVariationSelector(chars[index + 1]?.codePointAt(0)) || isEmojiModifier(chars[index + 1]?.codePointAt(0))) {
        emoji += chars[index + 1];
        index += 1;
      }

      flushText();
      nodes.push(createEmojiImage(emoji));
      continue;
    }

    text += char;
  }

  flushText();
  return nodes;
}

function createEmojiImage(emoji) {
  const image = document.createElement('img');
  image.className = 'twemoji';
  image.alt = emoji;
  image.draggable = false;
  image.src = `${TWEMOJI_BASE_URL}${toTwemojiCodepoint(emoji)}.svg`;
  image.addEventListener('error', () => {
    image.replaceWith(document.createTextNode(emoji));
  }, { once: true });
  return image;
}

function toTwemojiCodepoint(emoji) {
  return Array.from(emoji)
    .map((char) => char.codePointAt(0))
    .filter((codePoint) => !isVariationSelector(codePoint))
    .map((codePoint) => codePoint.toString(16))
    .join('-');
}

function isRegionalIndicator(codePoint) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiCodePoint(codePoint) {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function isEmojiModifier(codePoint) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isVariationSelector(codePoint) {
  return codePoint === 0xfe0e || codePoint === 0xfe0f;
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
