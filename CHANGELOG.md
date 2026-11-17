# Changelog

## Unreleased

- **Compare** has Fable 5.2 ticked by default next to Opus 5.5 and GPT-6-Astra. In the benchmark it made the cleanest clips, but takes about 5 minutes per clip, so the editor keeps Opus 5.5 as its default.
- **Stop a generation.** The bar under the director chat has a *Stop* button. The running model call is cancelled (Claude Code and Codex are ended, API requests aborted) and nothing is added to the clip.
- **Structured output for the Anthropic API.** The answer is checked against the animation schema by the API itself, so it always comes back as valid JSON in the right shape.
- **Access token for `HOST=0.0.0.0`.** Other devices on the network need the link with `?token=…` that the terminal shows once; the computer running OpenRig Studio doesn't. Set `OPENRIG_TOKEN` for a fixed token.
- The library list re-reads only clips that changed, instead of every clip with its whole history on every refresh.
- **Node.js 22 or newer.** Node 20 gets no security updates since April 2026. OpenRig Studio still starts on it, with a warning.
- For contributors: `npm run lint` (ESLint), the CI installs the API SDKs and checks the calls the app makes into them, and Dependabot sends one grouped update PR a week.
- **Claude Fable 5.2** replaces Fable 5.1 for Claude Code and the Anthropic API, with the refusal fallback. A remembered Fable 5.1 choice moves to Fable 5.2 on its own.
- Fixed: text sent to the server could get a broken character (ä, ß, emoji) when it arrived in more than one piece. Broken JSON is now answered with 400 instead of 500, and unexpected server errors are logged with their stack.
- Finished generation jobs are dropped from memory after an hour, so a server that runs for days doesn't keep every result.
- **Live demo** at https://hildlabs.github.io/openrig-studio/: the real web app with a browser-only stand-in for the server (`demo/`). Play and edit the example clips, history, R6, contact sheets and `.rbxmx` / Luau export work; generating and the Studio bridge need a local install. `npm run build-demo` builds it, a workflow publishes it to GitHub Pages.

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
