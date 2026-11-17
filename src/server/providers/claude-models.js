// Claude models offered for Claude Code (subscription) and the Anthropic API (key). One list, so
// both providers stay in step when a model is added or replaced.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: EFFORTS },
  { id: 'claude-fable-5-2', label: 'Fable 5.2', efforts: EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', efforts: EFFORTS },
];
// Models that support the server-side refusal fallback (re-runs a declined request on a fallback
// model). Older ids stay in the set for anyone who types them as a custom model.
export const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
