// API-key providers using the official SDKs. The SDKs are loaded lazily, so subscription-only
// users (Claude Code / Codex CLI) don't need `npm install`.
import { CLAUDE_MODELS, FALLBACK_MODELS } from './claude-models.js';

export const ANTHROPIC_MODELS = CLAUDE_MODELS;

async function load(name) {
  try { return (await import(name)).default; }
  catch { throw new Error(`The package "${name}" is missing. Run "npm install" in the OpenRig Studio folder to use API keys.`); }
}

export async function runAnthropic(apiKey, { model, effort, system, text, images = [], schema, signal }) {
  const Anthropic = await load('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const content = [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data.toString('base64') } })),
    { type: 'text', text },
  ];
  const params = {
    model,
    max_tokens: 64000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    // Structured output: the answer is always JSON in the shape of the schema.
    ...(effort || schema ? { output_config: { ...(effort ? { effort } : {}), ...(schema ? { format: { type: 'json_schema', schema } } : {}) } } : {}),
  };
  let message;
  try {
    message = FALLBACK_MODELS.has(model)
      ? await client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal }).finalMessage()
      : await client.messages.stream(params, { signal }).finalMessage();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof Anthropic.AuthenticationError) throw new Error('The Anthropic API key was rejected. Check it in Settings.', { cause: error });
    if (error instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached. Try again in a moment.', { cause: error });
    if (error instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${error.status ?? ''}: ${error.message}`, { cause: error });
    throw error;
  }
  if (message.stop_reason === 'refusal') throw new Error(`The model declined the request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`);
  const u = message.usage ?? {};
  return {
    text: message.content.filter(b => b.type === 'text').map(b => b.text).join(''),
    usage: { calls: 1, input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: 0 },
  };
}

export async function runOpenAI(apiKey, { model, effort, system, text, images = [], signal }) {
  const OpenAI = await load('openai');
  const client = new OpenAI({ apiKey });
  const content = [
    { type: 'input_text', text },
    ...images.map(img => ({ type: 'input_image', image_url: `data:image/png;base64,${img.data.toString('base64')}` })),
  ];
  let response;
  try {
    response = await client.responses.create({
      model,
      instructions: system,
      input: [{ role: 'user', content }],
      max_output_tokens: 64000,
      ...(effort ? { reasoning: { effort } } : {}),
    }, { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof OpenAI.AuthenticationError) throw new Error('The OpenAI API key was rejected. Check it in Settings.', { cause: error });
    if (error instanceof OpenAI.RateLimitError) throw new Error('OpenAI rate limit reached. Try again in a moment.', { cause: error });
    if (error instanceof OpenAI.APIError) throw new Error(`OpenAI API error ${error.status ?? ''}: ${error.message}`, { cause: error });
    throw error;
  }
  const u = response.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    text: response.output_text ?? '',
    usage: { calls: 1, input: (u.input_tokens ?? 0) - cached, cached, output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0 },
  };
}

// Cheap key checks (list models), no generation.
export async function testAnthropic(apiKey) {
  const Anthropic = await load('@anthropic-ai/sdk');
  try { return `${(await new Anthropic({ apiKey }).models.list()).data?.length ?? 0} models available`; }
  catch (error) { throw error instanceof Anthropic.AuthenticationError ? new Error('The Anthropic API key was rejected.') : error; }
}
export async function testOpenAI(apiKey) {
  const OpenAI = await load('openai');
  try { return `${(await new OpenAI({ apiKey }).models.list()).data?.length ?? 0} models available`; }
  catch (error) { throw error instanceof OpenAI.AuthenticationError ? new Error('The OpenAI API key was rejected.') : error; }
}
