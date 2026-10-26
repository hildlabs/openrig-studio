# How OpenRig Studio works

## Clip format

A clip is JSON: `name`, `loop`, `priority`, `keyframes` and `events`. Each keyframe has a time `t` (seconds) and `poses` keyed by R15 part name (`LowerTorso`, `RightUpperArm`, …). A pose has `rot` ([x, y, z] in degrees, applied like `CFrame.Angles`), `pos` (studs, practically only for `LowerTorso`) and `ease` (`InOut`, `Out`, `In`, `Linear`, `Constant`). A pose is the `Motor6D.Transform` of the joint whose Part1 has that name, exactly what a Roblox `Pose` stores.

Models may additionally use:

- `ik`: hand/foot targets per keyframe. Hands default to body space, feet to world space; `{ "pos": [...], "space": "world" | "body" }` overrides.
- `contact: "air"` on keyframes where both feet are off the ground.
- `plan` and `notes`: shown in the chat, not stored in the clip.

## Pipeline (`src/core/anim.js`)

1. **Normalise:** unknown joints are dropped, offsets clamped, joints that are first keyed later start from rest at t = 0.
2. **Turns beyond 180°:** Roblox always blends the shorter way, so one joint can never turn 180° or more between two keys. Model angles are taken literally (0 → 360 is a full spin) and large steps are split into keys at most 120° apart. The original easing's timing is kept: the outer pieces keep the slow start and end, inner pieces are linear. Stored or imported data is unwrapped to the nearest equivalent instead, which is what Roblox does anyway.
3. **Limits:** angles outside the joint limits in `src/core/rig.js` are clamped and reported.
4. **Foot lock:** a foot that keeps the same world target in consecutive keyframes gets in-between keys every ~0.07 s, so it doesn't slide or sink while the body moves. The legs blend linearly between them while the body keeps its own easing, so after motion flow (step 7) these keys are solved again, and wherever the foot still leaves its place by more than 0.02 studs between two of them another key is added in the middle (down to 1/60 s apart).
5. **IK** (`src/core/ik.js`): damped least squares on upper limb (x, y, z) and hinge (x), starting from the model's own angles so the intended elbow/knee direction is kept. Feet are kept flat and point where the hips point.
6. **Grounding:** `LowerTorso` height is shifted so the lowest foot touches y = 0 on every keyframe not marked as in the air. IK and grounding run twice so they agree.
7. **Motion flow** (model output only): with no tangents across keys, `InOut` on every key makes continuous motion stop at each key. Keys a joint passes through in the same direction get pass-through easing (extreme → pass `In`, pass → extreme `Out`, pass → pass `Linear`).
8. **Checks:** feet inside the ground, hands or forearms inside head or torso, joints snapping (limbs over 1600°/s, whole body over 2400°/s), loops whose end differs from the start.

The findings go back to the model: the check report, measured positions of head, hands and feet per keyframe, and optionally a contact sheet image of the draft (visual review).

## Matching Roblox playback

The preview samples clips the way Roblox does. These rules were measured in Roblox Studio by playing KeyframeSequences on a default R15 rig with `Animator:StepAnimations` and reading the joint transforms. The tests in `test/core.test.js` keep the measured values.

| Rule | Detail |
|---|---|
| Tracks are per joint | A joint missing from a keyframe is interpolated between its neighbouring keys. Container poses with `Weight 0` don't affect it. |
| Easing comes from the earlier pose | The style/direction of the pose at the start of a segment shapes that segment. |
| `CubicV2` is a cubic ease | In = a³, Out = 1 − (1 − a)³, InOut = the usual piecewise cubic. |
| Legacy `Cubic` runs reversed | `Cubic` + `In` behaves like `CubicV2` + `Out` and vice versa. Imports translate it. |
| `Constant` needs direction `Out` | `Constant` + `Out` holds until the next key; `Constant` + `In` jumps to the next value immediately. Exports always write `Out`. |
| Rotation blending depends on the style | Between two `Linear` poses Roblox uses a normalised quaternion lerp (nlerp). In every other case it lerps rotation vectors (axis × angle). |
| Always the shorter way | Both blends first flip the second rotation into the first one's hemisphere. |
| New R15 rigs use AnimationConstraint | `CreateHumanoidModelFromDescription` builds joints as `AnimationConstraint`s (Attachment0 · Transform = Attachment1), not `Motor6D`s; the math is the same. |
| Registered sequences load asynchronously | After `KeyframeSequenceProvider:RegisterKeyframeSequence`, wait for `track.Length > 0` before stepping. |

## Rig data

Part sizes and joint offsets (`src/core/rig.js`) come from the attachments of Studio's default R15 rig: `Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse()`, with C0/C1 being pure translations. The rest pose stands with the soles at y = 0.

## Providers (`src/server/providers/`)

- **Claude Code:** `claude -p --output-format json` in an empty temp folder with a custom system prompt file, no MCP servers and no tools (only `Read` when an image has to be looked at).
- **Codex CLI:** `codex exec --json --sandbox read-only` in an empty temp folder; images are attached with `--image`. Models come from Codex's own model cache.
- **Anthropic API:** official SDK, streaming, effort via `output_config`, prompt caching on the system prompt, server-side refusal fallback on models that support it.
- **OpenAI API:** official SDK, Responses API, `reasoning.effort`.

## Roblox Studio bridge (`src/server/studio.js`)

Each action starts Roblox's `StudioMCP` executable, speaks MCP over stdio (`list_roblox_studios`, `get_studio_state`, `execute_luau`) and closes it again. Clips are built in Studio from a Luau snippet (`toLuauBuilder`), saved under `ServerStorage › RBX_ANIMSAVES › OpenRigPreview`, played on a preview rig with `Animator:StepAnimations` in edit mode, or registered and played on the local avatar during a playtest.
