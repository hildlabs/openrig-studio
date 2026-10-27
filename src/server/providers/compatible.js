// Any API that speaks OpenAI's Chat Completions format: DeepSeek, Qwen, Kimi, GLM, OpenRouter,
// or local models through Ollama or LM Studio. Plain fetch, so no `npm install` is needed.
// The answer is streamed: generations can take longer than Node's 5 minute header timeout.

const TIMEOUT_MS = 20 * 60 * 1000;

export const baseUrl = url => String(url ?? '').trim().replace(/\/+$/, '');
// reasoning_effort is offered but only sent when chosen (the editor defaults to the server's own).
export const models = list => String(list ?? '').split(',').map(x => x.trim()).filter(Boolean).map(id => ({ id, label: id, efforts: ['low', 'medium', 'high'] }));

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
  const line = l => {
    const data = l.match(/^data:\s?(.*)$/)?.[1];
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.error) throw new Error(`API error: ${event.error.message ?? JSON.stringify(event.error)}`);
    const choice = event.choices?.[0];
    if (choice?.delta?.content) text += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (event.usage) usage = event.usage;
  };
  for await (const chunk of body) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    lines.forEach(line);
  }
  line(rest + decoder.decode()); // a last event without a line break
  return { text, usage, finish };
}
// Servers that ignore "stream": true answer with one chat.completion object instead.
async function readWhole(res) {
  const body = await res.json();
  if (body.error) throw new Error(`API error: ${body.error.message ?? JSON.stringify(body.error)}`);
  const choice = body.choices?.[0];
  return { text: choice?.message?.content ?? '', usage: body.usage ?? null, finish: choice?.finish_reason ?? null };
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
  const streamed = !(res.headers.get('content-type') ?? '').includes('application/json');
  const { text: answer, usage: u, finish } = streamed ? await readStream(res.body) : await readWhole(res);
  if (finish === 'length') throw new Error('The answer was cut off by the model\'s output limit. Raise "Max output tokens" for the OpenAI-compatible API in Settings (most animations need 8,000 to 20,000, thinking models more). With Ollama, also raise its context length, e.g. OLLAMA_CONTEXT_LENGTH=32768.');
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return {
    text: stripThinking(answer),
    usage: { calls: 1, input: (u?.prompt_tokens ?? 0) - cached, cached, output: u?.completion_tokens ?? 0, reasoning: u?.completion_tokens_details?.reasoning_tokens ?? 0 },
  };
}

// Connection check through the model list, which nearly every server has. A 404 there almost
// always means a wrong base URL (most end in /v1), so it is reported as one.
export async function testCompatible({ url, key }) {
  const res = await fetch(endpoint(url, '/models'), { headers: headers(key), signal: AbortSignal.timeout(20000) });
  if (res.status === 404) throw new Error(`The server answered, but ${baseUrl(url)}/models doesn't exist. Check the base URL: most end in /v1.`);
  if (!res.ok) throw await failure(res);
  const list = (await res.json()).data ?? [];
  return `${list.length} models available`;
}
