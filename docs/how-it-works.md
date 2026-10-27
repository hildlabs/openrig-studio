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
8. **Closing loops** (model output only): models write the same first and last keyframe for a loop, but IK and grounding can solve them slightly differently. Every joint whose end differs from its start gets the start pose copied onto the last keyframe. Edited clips are only checked, so the editor never changes the last keyframe behind the user's back.
9. **Grounding between keys:** grounding only sees keyframes, but between them legs can still push through the floor, most at take-offs where the legs stretch before the body rises. The clip is sampled at 60 fps; where a foot sinks more than 0.05 studs, the body gets a key at the deepest frame, lifted so the foot touches the ground, and the segment's easing is split (`InOut` → `In` + `Out`, …) so the motion flows through it.
10. **Checks:** feet inside the ground, hands or forearms inside head or torso, joints snapping (limbs over 1600°/s, whole body over 2400°/s), loops whose end differs from the start.

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
| Root offsets are never scaled | A `LowerTorso` pose of (0, 1, 0.5) moves the joint by exactly that on the default rig, a 150 % rig and an Rthro avatar alike. A clip made for one body jumps relatively lower on a bigger one. |

## Rig data

Part sizes and joint offsets (`src/core/rig.js`) come from the attachments of Studio's default R15 rig: `Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse()`. The default rig's C0/C1 are pure translations; imported rigs may carry rotations (`c0R`, `c1R`). The rest pose stands with the soles at y = 0. Every function that works on a body takes the rig as a parameter; models always work on the default one.

## R6 (`RIG_R6` in `src/core/rig.js`)

The classic R6 body was read from Studio: six parts, Motor6Ds whose C0 and C1 carry the same rotation Q (RootJoint and Neck swap y and z, shoulders and hips turn 90° about y). Because Q is the same on both sides, the rig is kept in the R15 axes with pure translations, and a pose means the same as on R15 (x+ swings an arm forward). Only at the Roblox boundary is it turned into the joint's own frame: `Transform = Qᵀ · pose · Q` on export, `pose = Q · Transform · Qᵀ` on import. Moving the body up 0.8 studs is therefore a Torso Pose of (0, 0, 0.8) in Roblox.

Checked in Studio: a test clip with every joint turned, the body moved and Linear/Out easing places every part within 0.0001 studs of Roblox's playback, orientation included (`test/r6.test.js` keeps the values). Roblox reports a HipHeight of 0 for R6; here the legs (2 studs) count as hip height, and the R6 model pivots around its head, so the preview rig in Studio is placed by its root part. The head part is 2 × 1 × 1, but the preview draws it at the size of its visible mesh (1.25).

R6 has no IK (one-piece limbs), so the pipeline skips foot targets; grounding uses the corners of the legs. The model gets its own system prompt (`prompts/system-r6.md`) with rendered poses.

## Other proportions (`retarget` in `src/core/anim.js`)

A clip can be made for an imported rig (`data/rigs`, read from the rig selected in Studio: part sizes, Motor6D or AnimationConstraint offsets, HumanoidDescription). Moving a clip to another rig:

1. Joint rotations stay as they are.
2. Root motion scales with the ratio of the hip heights, since Roblox doesn't scale it (see above).
3. Every keyframe is grounded again on the new body; keyframes where both feet were off the ground in the source stay in the air.
4. A foot that stands flat and still in the source is held where it stood on the new legs when that plant began. Only if it drifts more than 0.04 studs does the leg get IK, and the foot keeps its own rotation.
5. Keys added to a joint that was only interpolated there split the segment with the easings that follow its original curve best.

Generating for such a clip: the model sees the current version retargeted to the default body, and its answer is retargeted onto the clip's rig. Checked in Studio on an Rthro avatar: the preview places every part within 0.003 studs of where Roblox does.

## Providers (`src/server/providers/`)

- **Claude Code:** `claude -p --output-format json` in an empty temp folder with a custom system prompt file, no MCP servers and no tools (only `Read` when an image has to be looked at).
- **Codex CLI:** `codex exec --json --sandbox read-only` in an empty temp folder; images are attached with `--image`. Models come from Codex's own model cache.
- **Anthropic API:** official SDK, streaming, effort via `output_config`, prompt caching on the system prompt, server-side refusal fallback on models that support it.
- **OpenAI API:** official SDK, Responses API, `reasoning.effort`.
- **OpenAI-compatible API:** plain `fetch` to `<base URL>/chat/completions`, streamed so long generations don't hit Node's 5 minute header timeout. `max_tokens` and `reasoning_effort` are only sent when set, since servers differ in what they accept. `<think>` blocks some servers put into the answer are removed. Visual review only runs when Settings say the models can see images.

## Roblox Studio bridge (`src/server/studio.js`)

Each action starts Roblox's `StudioMCP` executable, speaks MCP over stdio (`list_roblox_studios`, `get_studio_state`, `execute_luau`) and closes it again. Clips are built in Studio from a Luau snippet (`toLuauBuilder`), saved under `ServerStorage › RBX_ANIMSAVES › OpenRigPreview`, played on a preview rig with `Animator:StepAnimations` in edit mode, or registered and played on the local avatar during a playtest.
