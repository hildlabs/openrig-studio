# Changelog

## 0.2.0

### New

- **R6.** Choose *Clip › Rig › R6* in a new clip. R6 has its own system prompt, preview body, Studio preview rig, export and import. Checked in Studio: the preview matches Roblox's playback within 0.0001 studs.
- **Your own avatar and other R15 proportions.** *Clip › Rig › Import selected rig from Studio…* reads a rig (Rthro, scaled avatars, your avatar from the Rig Builder) and fits the clip to it: root motion scales, planted feet stay planted, the body stays on the ground. Later requests for the clip are fitted the same way. Rigs can be renamed and deleted in Settings.
- **Other AI models.** An OpenAI-compatible API provider for DeepSeek, Qwen, Kimi, GLM, OpenRouter, or local models through Ollama or LM Studio. Visual review is skipped for models that can't see images.
- **Undo and redo** in the editor (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y).
- The library shows which rig a clip is made for.
- `npm run bench` for contributors: fixed requests through the real pipeline, with measurements, contact sheets and a replay mode that tests pipeline changes without model calls.

### Fixed

- Saving on Windows could fail with "EPERM: operation not permitted, rename …" when a clip was being read at the same time, which happened during generation.
- Planted feet drifted between foot-lock keys, and feet went through the ground between keyframes.
- Loops from model output didn't always end exactly where they started.
- An answer that uses joints the rig doesn't have gets one retry, then a clear error, instead of an almost empty clip.

### Security

- Luau injection through clip names, CDN integrity hashes, fonts served locally, and settings that can only be changed on the computer running OpenRig Studio.

## 0.1.0

First release: generate R15 animations with Claude Code, the Codex CLI or API keys, preview them like Roblox plays them, compare models, keep a library, and send clips to Roblox Studio.
