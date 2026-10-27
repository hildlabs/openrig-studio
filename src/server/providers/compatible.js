// Any API that speaks OpenAI's Chat Completions format: DeepSeek, Qwen, Kimi, GLM, OpenRouter,
// or local models through Ollama or LM Studio. Plain fetch, so no `npm install` is needed.
// The answer is streamed: generations can take longer than Node's 5 minute header timeout.

const TIMEOUT_MS = 20 * 60 * 1000;

export const baseUrl = url => String(url ?? '').trim().replace(/\/+$/, '');
export const models = list => String(list ?? '').split(',').map(x => x.trim()).filter(Boolean).map(id => ({ id, label: id, efforts: [] }));

function endpoint(url, route) {
  const base = baseUrl(url);
  if (!/^https?:\/\/[^\s/]+/.test(base)) throw new Error('Set the base URL of the OpenAI-compatible API in Settings, e.g. https://api.deepseek.com/v1.');
  return `${base}${route}`;
}
const headers = key => ({ 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) });

async function failure(res) {
  let detail = '';
  try { const body = await res.text(); detail = (JSON.parse(body).error?.message ?? body).toString().slice(0, 300); } catch { /* no body */ }
  if (res.status === 401 || res.status === 403) return new Error(`The API key was rejected (${res.status}). Check it in Settings.`);
  if (res.status === 429) return new Error('Rate limit reached. Try again in a moment.');
  return new Error(`API error ${res.status}${detail ? `: ${detail}` : ''}`);
}

// Reasoning models behind some servers (e.g. Ollama) put their thinking into the answer itself.
export const stripThinking = text => text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// Reads a Server-Sent Events stream of chat.completion.chunk objects.
export async function readStream(body) {
  let text = '', usage = null, finish = null, rest = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) {
      const data = line.match(/^data:\s?(.*)$/)?.[1];
      if (!data || data === '[DONE]') continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.error) throw new Error(`API error: ${event.error.message ?? JSON.stringify(event.error)}`);
      const choice = event.choices?.[0];
      if (choice?.delta?.content) text += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (event.usage) usage = event.usage;
    }
  }
  return { text, usage, finish };
}

export async function runCompatible({ url, key, maxTokens }, { model, effort, system, text, images = [] }) {
  if (!model) throw new Error('Choose a model. Add model ids for the OpenAI-compatible API in Settings.');
  const content = images.length
    ? [{ type: 'text', text }, ...images.map(img => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${img.data.toString('base64')}` } }))]
    : text;
  const res = await fetch(endpoint(url, '/chat/completions'), {
    method: 'POST',
    headers: headers(key),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      stream: true,
      stream_options: { include_usage: true },
      ...(Number(maxTokens) > 0 ? { max_tokens: Number(maxTokens) } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
    }),
  });
  if (!res.ok) throw await failure(res);
  const { text: answer, usage: u, finish } = await readStream(res.body);
  if (finish === 'length') throw new Error('The answer was cut off by the model\'s output limit. Raise "Max output tokens" for the OpenAI-compatible API in Settings (most animations need 8,000 to 20,000, thinking models more). With Ollama, also raise its context length, e.g. OLLAMA_CONTEXT_LENGTH=32768.');
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return {
    text: stripThinking(answer),
    usage: { calls: 1, input: (u?.prompt_tokens ?? 0) - cached, cached, output: u?.completion_tokens ?? 0, reasoning: u?.completion_tokens_details?.reasoning_tokens ?? 0 },
  };
}

// Connection check: most servers list their models; some don't, which is fine.
export async function testCompatible({ url, key }) {
  const res = await fetch(endpoint(url, '/models'), { headers: headers(key), signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return 'Connected (the server has no model list)';
  if (!res.ok) throw await failure(res);
  const list = (await res.json()).data ?? [];
  return `${list.length} models available`;
}
