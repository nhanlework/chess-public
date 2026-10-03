// Thin clients for each AI backend. Each call() returns the raw text
// reply from the model given a single user prompt string.

const AI_DEFAULT_MODELS = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  claude: 'claude-sonnet-5',
  lmstudio: 'local-model'
};

// Cloud APIs are normally fast; local LM Studio models (especially ones
// that "think" before answering) can genuinely take a couple of minutes
// on modest hardware, so they get a much longer budget.
const REQUEST_TIMEOUT_MS = {
  gemini: 45000,
  openai: 45000,
  claude: 45000,
  lmstudio: 180000
};

function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timeoutError = new Error(`Timed out after ${Math.round(ms / 1000)}s waiting for a response.`);
  const timer = setTimeout(() => controller.abort(timeoutError), ms);
  const run = promise(controller.signal).catch((err) => {
    if (controller.signal.aborted) throw timeoutError;
    throw err;
  }).finally(() => clearTimeout(timer));
  return { controller, run };
}

async function callGemini(cfg, prompt) {
  const model = cfg.model || AI_DEFAULT_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const { run } = withTimeout((signal) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8 }
    })
  }), REQUEST_TIMEOUT_MS.gemini);
  const res = await run;
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Gemini lỗi HTTP ${res.status}`);
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error('Gemini không trả về nội dung.');
  return text;
}

async function callOpenAI(cfg, prompt) {
  const model = cfg.model || AI_DEFAULT_MODELS.openai;
  const { run } = withTimeout((signal) => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8
    })
  }), REQUEST_TIMEOUT_MS.openai);
  const res = await run;
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI lỗi HTTP ${res.status}`);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('ChatGPT không trả về nội dung.');
  return text;
}

async function callClaude(cfg, prompt) {
  const model = cfg.model || AI_DEFAULT_MODELS.claude;
  const { run } = withTimeout((signal) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  }), REQUEST_TIMEOUT_MS.claude);
  const res = await run;
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Claude lỗi HTTP ${res.status}`);
  const text = (data?.content || []).map(b => b.text || '').join('');
  if (!text) throw new Error('Claude không trả về nội dung.');
  return text;
}

async function callLMStudio(cfg, prompt) {
  const base = (cfg.baseUrl || 'http://localhost:1234/v1').replace(/\/$/, '');
  const model = cfg.model || AI_DEFAULT_MODELS.lmstudio;
  const { run } = withTimeout((signal) => fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8
    })
  }), REQUEST_TIMEOUT_MS.lmstudio);
  const res = await run;
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `LM Studio lỗi HTTP ${res.status}`);
  const message = data?.choices?.[0]?.message || {};
  // Reasoning models sometimes put everything in reasoning_content and leave
  // content empty (or vice versa) — try both before giving up.
  const text = message.content || message.reasoning_content || '';
  if (!text) throw new Error('LM Studio không trả về nội dung.');
  return text;
}

const AI_CALLERS = {
  gemini: callGemini,
  openai: callOpenAI,
  claude: callClaude,
  lmstudio: callLMStudio
};

async function callAiProvider(provider, cfg, prompt) {
  const fn = AI_CALLERS[provider];
  if (!fn) throw new Error('Nhà cung cấp AI không hợp lệ.');
  return fn(cfg, prompt);
}

async function testAiConnection(provider, cfg) {
  try {
    const text = await callAiProvider(provider, cfg, 'Trả lời đúng một từ: OK');
    return { ok: true, message: 'Kết nối thành công.', sample: text.slice(0, 200) };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}
