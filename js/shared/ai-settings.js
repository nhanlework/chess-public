// AI provider settings: persistence, connection indicator, the Settings
// modal, and the export/import/linked-config-file flows. Extracted verbatim
// from app.js so 2D and 3D can share it. Event listeners are only attached
// in init() (called after the DOM is ready), not at file-load time.
(function () {
  const STORAGE_KEY = 'chessAiSettings';

  const PROVIDER_LABELS = {
    gemini: 'Google Gemini',
    openai: 'ChatGPT (OpenAI)',
    claude: 'Claude (Anthropic)',
    lmstudio: 'LM Studio'
  };

  const CONFIG_DB_NAME = 'chessVsAiDB';
  const CONFIG_DB_STORE = 'handles';
  const CONFIG_DB_KEY = 'aiConfigFileHandle';
  const fsAccessSupported = 'showSaveFilePicker' in window;
  let configFileHandle = null;

  // ---------- Settings persistence ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupt storage */ }
    return {
      provider: 'gemini',
      gemini: { apiKey: '', model: AI_DEFAULT_MODELS.gemini },
      openai: { apiKey: '', model: AI_DEFAULT_MODELS.openai },
      claude: { apiKey: '', model: AI_DEFAULT_MODELS.claude },
      lmstudio: { baseUrl: 'http://localhost:1234/v1', model: AI_DEFAULT_MODELS.lmstudio }
    };
  }

  let settings = loadSettings();

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function currentProviderConfig() {
    return settings[settings.provider] || {};
  }

  function providerConfigured() {
    const cfg = currentProviderConfig();
    if (settings.provider === 'lmstudio') return !!(cfg.baseUrl);
    return !!(cfg.apiKey);
  }

  // ---------- DOM refs ----------
  const connDot = document.getElementById('connDot');
  const connText = document.getElementById('connText');
  const connDetail = document.getElementById('connDetail');

  function neutralConnText() {
    return providerConfigured() ? 'Configured (not tested)' : 'AI not configured';
  }

  function currentModelLabel() {
    const cfg = currentProviderConfig();
    return cfg.model || AI_DEFAULT_MODELS[settings.provider] || '';
  }

  function updateConnDetail() {
    if (providerConfigured()) {
      connDetail.textContent = `${PROVIDER_LABELS[settings.provider] || settings.provider} · ${currentModelLabel()}`;
    } else {
      connDetail.textContent = '';
    }
  }

  function updateConnIndicator(state, text) {
    // Engine mode never talks to a server: always show a fixed "ready" state.
    if (window.ChessOpponents && ChessOpponents.getMode() === 'engine') {
      connDot.className = 'status-dot ok';
      connText.textContent = 'Chess Engine (offline)';
      connDetail.textContent = 'Built-in engine · no connection needed';
      return;
    }
    connDot.className = 'status-dot' + (state ? ' ' + state : '');
    connText.textContent = text;
    updateConnDetail();
  }

  // Called when the user switches the Opponent dropdown, to re-render the
  // indicator for the newly selected mode without re-running a test call.
  function refreshConnIndicator() {
    if (window.ChessOpponents && ChessOpponents.getMode() === 'engine') {
      updateConnIndicator();
      return;
    }
    const verified = lastVerifiedFingerprint === settingsFingerprint();
    updateConnIndicator(verified ? 'ok' : '', verified ? 'Connected' : neutralConnText());
  }

  // ---------- Settings modal ----------
  const providerFieldsEl = document.getElementById('providerFields');
  const providerSelect = document.getElementById('providerSelect');

  function renderProviderFields() {
    const provider = providerSelect.value;
    const cfg = settings[provider] || {};
    providerFieldsEl.innerHTML = '';

    if (provider === 'lmstudio') {
      providerFieldsEl.innerHTML = `
        <label>Base URL</label>
        <input type="text" id="fld_baseUrl" placeholder="http://localhost:1234/v1" value="${cfg.baseUrl || ''}" />
        <label>Model (optional)</label>
        <input type="text" id="fld_model" placeholder="${AI_DEFAULT_MODELS.lmstudio}" value="${cfg.model || ''}" />
      `;
    } else {
      const MODEL_DOCS_LINKS = {
        gemini: { url: 'https://ai.google.dev/gemini-api/docs/models', label: 'ai.google.dev/gemini-api/docs/models', name: 'Gemini' },
        openai: { url: 'https://platform.openai.com/docs/models', label: 'platform.openai.com/docs/models', name: 'OpenAI' },
        claude: { url: 'https://docs.claude.com/en/docs/about-claude/models/overview', label: 'docs.claude.com/en/docs/about-claude/models/overview', name: 'Claude' }
      };
      const docLink = MODEL_DOCS_LINKS[provider];
      const modelListHint = docLink
        ? `<p class="field-hint">See available ${docLink.name} models: <a href="${docLink.url}" target="_blank" rel="noopener noreferrer">${docLink.label}</a></p>`
        : '';
      providerFieldsEl.innerHTML = `
        <label>API Key</label>
        <input type="password" id="fld_apiKey" placeholder="Enter API key" value="${cfg.apiKey || ''}" />
        <label>Model (optional)</label>
        <input type="text" id="fld_model" placeholder="${AI_DEFAULT_MODELS[provider]}" value="${cfg.model || ''}" />
        ${modelListHint}
      `;
    }
  }

  function readProviderFieldsIntoSettings() {
    const provider = providerSelect.value;
    settings.provider = provider;
    if (provider === 'lmstudio') {
      settings.lmstudio = {
        baseUrl: document.getElementById('fld_baseUrl').value.trim() || 'http://localhost:1234/v1',
        model: document.getElementById('fld_model').value.trim()
      };
    } else {
      settings[provider] = {
        apiKey: document.getElementById('fld_apiKey').value.trim(),
        model: document.getElementById('fld_model').value.trim()
      };
    }
  }

  // Tracks the exact provider config that was last confirmed working, so
  // clicking Save right after a successful Test Connection doesn't wipe the
  // "Connected" status back to "not tested".
  let lastVerifiedFingerprint = null;
  function settingsFingerprint() {
    return JSON.stringify({ provider: settings.provider, config: currentProviderConfig() });
  }

  // ---------- AI config export / import ----------
  function serializeAiConfig() {
    return {
      format: 'chess-vs-ai-config',
      version: 1,
      savedAt: new Date().toISOString(),
      settings
    };
  }

  function exportAiConfig() {
    readProviderFieldsIntoSettings();
    const data = serializeAiConfig();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chess-ai-config.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importAiConfigData(data) {
    const resultEl = document.getElementById('testResult');
    if (!data || !data.settings || !data.settings.provider) {
      resultEl.textContent = 'This file does not look like a valid AI config.';
      return;
    }
    settings = Object.assign(loadSettings(), data.settings);
    saveSettings();
    writeSettingsToConfigFile();
    providerSelect.value = settings.provider;
    renderProviderFields();
    updateConnIndicator('', neutralConnText());
    resultEl.textContent = 'Config imported and saved.';
  }

  // ---------- Linked config file (ai-config.json next to the HTML page) ----------
  // Static pages can't silently read/write an arbitrary file on disk without
  // user action (browser security). The File System Access API (Chrome/Edge
  // only) lets the user pick ai-config.json ONCE; we keep the handle in
  // IndexedDB so later sessions can re-request permission on that exact
  // file without reopening a file picker. Firefox/Safari fall back to the
  // Export/Import buttons above.
  const configFileStatusEl = document.getElementById('configFileStatus');

  function openHandleDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(CONFIG_DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getStoredHandle() {
    const db = await openHandleDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG_DB_STORE, 'readonly');
      const req = tx.objectStore(CONFIG_DB_STORE).get(CONFIG_DB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function setStoredHandle(handle) {
    const db = await openHandleDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIG_DB_STORE, 'readwrite');
      tx.objectStore(CONFIG_DB_STORE).put(handle, CONFIG_DB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function ensurePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    try {
      return (await handle.requestPermission(opts)) === 'granted';
    } catch (e) {
      return false;
    }
  }

  function setConfigFileStatus(text) {
    if (configFileStatusEl) configFileStatusEl.textContent = 'Config file: ' + text;
  }

  async function writeSettingsToConfigFile() {
    if (!configFileHandle) return;
    try {
      const writable = await configFileHandle.createWritable();
      await writable.write(JSON.stringify(serializeAiConfig(), null, 2));
      await writable.close();
    } catch (err) {
      console.error('Failed to write ai-config.json', err);
    }
  }

  async function syncWithConfigFile() {
    let existing = null;
    try {
      const file = await configFileHandle.getFile();
      const text = await file.text();
      if (text.trim()) existing = JSON.parse(text);
    } catch (e) { /* new or empty file */ }

    if (existing && existing.settings) {
      importAiConfigData(existing);
    } else {
      readProviderFieldsIntoSettings();
      await writeSettingsToConfigFile();
    }
  }

  async function linkConfigFile() {
    if (!fsAccessSupported) {
      alert('This browser does not support linking a local file directly (Chrome/Edge required). Use Export/Import Config below instead.');
      return;
    }
    try {
      let handle = await getStoredHandle();
      if (handle) {
        const granted = await ensurePermission(handle);
        if (!granted) {
          setConfigFileStatus('permission denied for the previously linked file.');
          return;
        }
      } else {
        handle = await window.showSaveFilePicker({
          suggestedName: 'ai-config.json',
          types: [{ description: 'JSON Config', accept: { 'application/json': ['.json'] } }]
        });
        await setStoredHandle(handle);
      }
      configFileHandle = handle;
      await syncWithConfigFile();
      setConfigFileStatus(`linked (${handle.name})`);
    } catch (err) {
      if (err.name !== 'AbortError') {
        setConfigFileStatus('link failed — ' + err.message);
      }
    }
  }

  async function initConfigFile() {
    if (!fsAccessSupported) {
      setConfigFileStatus('not supported in this browser (use Export/Import below).');
      return;
    }
    try {
      const handle = await getStoredHandle();
      if (!handle) {
        setConfigFileStatus('not linked yet.');
        return;
      }
      // No user gesture available on page load, so only check silently —
      // requestPermission() without a gesture would just no-op.
      const opts = { mode: 'readwrite' };
      const already = (await handle.queryPermission(opts)) === 'granted';
      if (!already) {
        setConfigFileStatus(`linked (${handle.name}) — click "Link ai-config.json" to reconnect this session.`);
        return;
      }
      configFileHandle = handle;
      const file = await handle.getFile();
      const text = await file.text();
      if (text.trim()) {
        const data = JSON.parse(text);
        if (data && data.settings) {
          settings = Object.assign(loadSettings(), data.settings);
          saveSettings();
          updateConnIndicator('', neutralConnText());
        }
      }
      setConfigFileStatus(`linked (${handle.name})`);
    } catch (err) {
      setConfigFileStatus('not linked yet.');
    }
  }

  // ---------- Init: attach event listeners (called once DOM is ready) ----------
  function init() {
    document.getElementById('settingsBtn').addEventListener('click', () => {
      providerSelect.value = settings.provider;
      renderProviderFields();
      document.getElementById('testResult').textContent = '';
      document.getElementById('settingsModal').classList.remove('hidden');
    });
    document.getElementById('closeSettingsBtn').addEventListener('click', () => {
      document.getElementById('settingsModal').classList.add('hidden');
    });
    providerSelect.addEventListener('change', renderProviderFields);

    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      readProviderFieldsIntoSettings();
      saveSettings();
      writeSettingsToConfigFile();
      document.getElementById('settingsModal').classList.add('hidden');
      if (lastVerifiedFingerprint && lastVerifiedFingerprint === settingsFingerprint()) {
        updateConnIndicator('ok', 'Connected');
      } else {
        updateConnIndicator('', neutralConnText());
      }
    });

    document.getElementById('testConnBtn').addEventListener('click', async () => {
      readProviderFieldsIntoSettings();
      const resultEl = document.getElementById('testResult');
      resultEl.textContent = 'Testing...';
      updateConnIndicator('pending', 'Testing...');
      const res = await testAiConnection(settings.provider, currentProviderConfig());
      if (res.ok) {
        resultEl.textContent = 'Success. Sample reply: ' + res.sample;
        updateConnIndicator('ok', 'Connected');
        lastVerifiedFingerprint = settingsFingerprint();
      } else {
        resultEl.textContent = 'Failed: ' + res.message;
        updateConnIndicator('error', 'Connection error');
      }
    });

    document.getElementById('exportConfigBtn').addEventListener('click', exportAiConfig);

    const configFileInput = document.getElementById('configFileInput');
    document.getElementById('importConfigBtn').addEventListener('click', () => {
      configFileInput.value = '';
      configFileInput.click();
    });
    configFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          importAiConfigData(JSON.parse(reader.result));
        } catch (err) {
          document.getElementById('testResult').textContent = 'Could not read this config file: ' + err.message;
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('linkConfigFileBtn').addEventListener('click', linkConfigFile);

    updateConnIndicator('', neutralConnText());
    initConfigFile();
  }

  window.AiSettings = {
    getSettings: () => settings,               // settings can be reassigned on import, so always use the getter
    currentProviderConfig,
    providerConfigured,
    providerLabel: () => PROVIDER_LABELS[settings.provider] || settings.provider,
    updateConnIndicator,
    refreshConnIndicator,
    markVerified: () => { lastVerifiedFingerprint = settingsFingerprint(); },
    init
  };
})();
