// Roblox Studio bridge through Roblox's built-in MCP server (StudioMCP, ships with Studio).
// Each action opens one stdio JSON-RPC session, runs its tool calls and closes it again.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadSettings } from './settings.js';
import { firstExisting, newestIn } from './process.js';
import { toLuauBuilder, luaStr } from '../core/anim.js';
import { RIG_R15 } from '../core/rig.js';

export const RIG_NAME = 'OpenRigPreview';

export async function findStudioMcp() {
  const s = await loadSettings();
  const win = process.platform === 'win32' ? newestIn(path.join(process.env.LOCALAPPDATA ?? '', 'Roblox', 'Versions'), 'StudioMCP.exe') : null;
  const mac = process.platform === 'darwin' ? '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP' : null;
  return firstExisting([s.studioMcpPath, win, mac]);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function session(fn) {
  const exe = await findStudioMcp();
  if (!exe) throw new Error('Roblox Studio\'s MCP server was not found. Install Roblox Studio or set the StudioMCP path in Settings.');
  const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1, stderr = '';
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const wait = pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    clearTimeout(wait.timer);
    if (msg.error) wait.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))); else wait.resolve(msg.result);
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  const fail = e => { for (const w of pending.values()) { clearTimeout(w.timer); w.reject(e); } pending.clear(); };
  child.on('error', fail);
  child.on('exit', code => fail(new Error(`StudioMCP exited (${code}). ${stderr}`)));
  const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out. Is Roblox Studio open?`)); }, timeout) });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const textOf = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const call = async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: args });
    const text = textOf(result);
    if (result?.isError) throw new Error(`Studio: ${text.slice(0, 400)}`);
    return text;
  };
  try {
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'openrig-studio', version: '0.1.0' } }, 15000);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await sleep(1200); // Studio registers with a fresh proxy asynchronously
    const studios = async () => { try { return JSON.parse(await call('list_roblox_studios')).studios ?? []; } catch { return []; } };
    // Studio instances attach shortly after the proxy starts.
    const attached = async studioId => {
      for (const deadline = Date.now() + 8000; Date.now() < deadline; await sleep(400)) if ((await studios()).some(s => s.id === studioId)) return;
      throw new Error('That Studio window is not connected. Open the place in Roblox Studio and refresh the list.');
    };
    return await fn({ call, studios, attached });
  } finally {
    child.stdin.end();
    lines.close();
    child.kill();
  }
}

export const listStudios = () => session(({ studios }) => studios());

async function inEdit(s, studioId) {
  await s.attached(studioId);
  const state = await s.call('get_studio_state', { studio_id: studioId });
  return !/Current Studio Mode:\s*Edit/i.test(state) ? 'play' : 'edit';
}
async function luau(s, studioId, code, datamodel = 'Edit') {
  const res = (await s.call('execute_luau', { studio_id: studioId, datamodel_type: datamodel, code })).trim();
  if (res.startsWith('ERR:')) throw new Error(res.slice(4));
  return res;
}

const seqFn = (anim, rig = RIG_R15) => `(function()\n${toLuauBuilder(anim, rig)}\nend)`;
// The preview rig appears ~14 studs in front of the Studio camera, standing on whatever is below.
// For a clip made for an imported rig it gets that rig's HumanoidDescription (scales and body
// parts); a preview rig of another body is replaced.
const DESCRIPTION_KEYS = ['BodyTypeScale', 'DepthScale', 'HeadScale', 'HeightScale', 'ProportionScale', 'WidthScale', 'Head', 'Torso', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg'];
const ensureRig = (body = null) => `local function ensureRig()
	local body = ${luaStr(body?.id ?? 'R15')}
	local rig = workspace:FindFirstChild("${RIG_NAME}")
	if rig and (rig:GetAttribute("OpenRigBody") or "R15") ~= body then rig:Destroy() rig = nil end
	if rig then return rig end
	local desc = Instance.new("HumanoidDescription")
${DESCRIPTION_KEYS.filter(k => Number.isFinite(body?.description?.[k])).map(k => `	desc.${k} = ${Number(body.description[k])}
`).join('')}	rig = game:GetService("Players"):CreateHumanoidModelFromDescription(desc, Enum.HumanoidRigType.${body?.rig?.family === 'R6' ? 'R6' : 'R15'})
	rig.Name = "${RIG_NAME}"
	rig:SetAttribute("OpenRigBody", body)
	local cam = workspace.CurrentCamera
	local look = cam.CFrame.LookVector
	local flat = Vector3.new(look.X, 0, look.Z)
	if flat.Magnitude < 0.1 then flat = Vector3.new(0, 0, -1) end
	local spot = cam.CFrame.Position + flat.Unit * 14
	local hit = workspace:Raycast(spot + Vector3.new(0, 60, 0), Vector3.new(0, -500, 0))
	local ground = hit and hit.Position.Y or spot.Y - 3
	-- R6 reports a HipHeight of 0: its legs hang below the root part.
	local legs = rig.Humanoid.RigType == Enum.HumanoidRigType.R6 and rig["Left Leg"].Size.Y or rig.Humanoid.HipHeight
	local y = ground + legs + rig.HumanoidRootPart.Size.Y / 2
	rig.PrimaryPart = rig.HumanoidRootPart -- R6 models pivot around the head otherwise
	rig:PivotTo(CFrame.lookAt(Vector3.new(spot.X, y, spot.Z), Vector3.new(cam.CFrame.Position.X, y, cam.CFrame.Position.Z)))
	rig.HumanoidRootPart.Anchored = true
	rig.Parent = workspace
	return rig
end`;

// Saves clips where the Animation Editor keeps its saves: ServerStorage > RBX_ANIMSAVES > rig.
// items: [{ anim, rig }]
function pushLuau(items, body) {
  return `${ensureRig(body)}
local rig = ensureRig()
local storage = game:GetService("ServerStorage")
local saves = storage:FindFirstChild("RBX_ANIMSAVES")
if not saves then
	saves = Instance.new("Model")
	saves.Name = "RBX_ANIMSAVES"
	saves.Parent = storage
end
local slot = saves:FindFirstChild(rig.Name)
if not slot then
	slot = Instance.new("ObjectValue")
	slot.Name = rig.Name
	slot.Parent = saves
end
slot.Value = rig
local names = {}
for _, build in { ${items.map(x => seqFn(x.anim, x.rig)).join(',\n')} } do
	local seq = build()
	local old = slot:FindFirstChild(seq.Name)
	if old then old:Destroy() end
	seq.Parent = slot
	table.insert(names, seq.Name)
end
game:GetService("Selection"):Set({ rig })
return #names .. " → " .. slot:GetFullName()`;
}
// Plays a clip in the edit viewport via Animator:StepAnimations (max. 20 s).
function previewLuau(anim, loops, body) {
  return `local seq = ${seqFn(anim, body?.rig)}()
${ensureRig(body)}
local rig = ensureRig()
local hum = rig:FindFirstChildOfClass("Humanoid")
local animator = hum:FindFirstChildOfClass("Animator") or Instance.new("Animator", hum)
for _, tr in animator:GetPlayingAnimationTracks() do tr:Stop(0) end
local a = Instance.new("Animation")
a.AnimationId = game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(seq)
local track = animator:LoadAnimation(a)
track.Looped = true
track:Play(0, 1, 1)
local t0 = os.clock()
while track.Length == 0 and os.clock() - t0 < 5 do task.wait(0.05) end
if track.Length == 0 then return "ERR:Studio could not load the animation." end
local total = math.min(20, track.Length * ${loops})
local start, last = os.clock(), os.clock()
while os.clock() - start < total do
	task.wait()
	local now = os.clock()
	animator:StepAnimations(now - last)
	last = now
end
track:Stop(0)
animator:StepAnimations(0)
track:Destroy()
return string.format("%.1f s", total)`;
}
// Plays on the local player's avatar in a running playtest (client side, replicates).
function playtestLuau(anim, rig = RIG_R15) {
  const family = rig.family ?? 'R15', other = family === 'R6' ? 'R15' : 'R6';
  return `local player = game:GetService("Players").LocalPlayer
local char = player.Character or player.CharacterAdded:Wait()
local hum = char:WaitForChild("Humanoid", 10)
if not hum then return "ERR:The avatar has no Humanoid." end
if hum.RigType ~= Enum.HumanoidRigType.${family} then return "ERR:The playtest avatar is ${other}; this animation needs ${family} (Game Settings > Avatar)." end
local animator = hum:FindFirstChildOfClass("Animator") or Instance.new("Animator", hum)
for _, tr in animator:GetPlayingAnimationTracks() do
	if tr.Animation and tr.Animation.Name == "OpenRigPreview" then tr:Stop(0.1) end
end
local a = Instance.new("Animation")
a.Name = "OpenRigPreview"
a.AnimationId = game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(${seqFn(anim, rig)}())
local track = animator:LoadAnimation(a)
track.Priority = Enum.AnimationPriority.Action4
track.Looped = ${anim.loop === true}
track:Play(0.1)
return player.Name`;
}
const LIST_SAVES = `local saves = game:GetService("ServerStorage"):FindFirstChild("RBX_ANIMSAVES")
local out = {}
if saves then
	for _, d in saves:GetDescendants() do
		if d:IsA("KeyframeSequence") then
			table.insert(out, { path = d:GetFullName(), name = d.Name, rig = d.Parent and d.Parent.Name or "", keys = #d:GetKeyframes() })
		end
	end
end
return game:GetService("HttpService"):JSONEncode(out)`;
const pullLuau = fullName => `local target = ${luaStr(fullName)}
local seq
for _, d in game:GetService("ServerStorage"):GetDescendants() do
	if d:IsA("KeyframeSequence") and d:GetFullName() == target then seq = d break end
end
if not seq then return "ERR:KeyframeSequence not found: " .. target end
local out = { name = seq.Name, loop = seq.Loop, priority = seq.Priority.Name, keyframes = {} }
for _, kf in seq:GetKeyframes() do
	local k = { t = kf.Time, poses = {}, markers = {} }
	for _, p in kf:GetDescendants() do
		if p:IsA("Pose") then
			table.insert(k.poses, { p.Name, p.Weight, { p.CFrame:GetComponents() }, p.EasingStyle.Name, p.EasingDirection.Name })
		end
	end
	for _, m in kf:GetMarkers() do table.insert(k.markers, { m.Name, m.Value }) end
	table.insert(out.keyframes, k)
end
return game:GetService("HttpService"):JSONEncode(out)`;

// Reads the proportions of the selected character rig (or the rig a selected part belongs to):
// part sizes, Motor6D offsets and, if it has one, its HumanoidDescription for the preview rig.
const READ_RIG = `local model
for _, inst in game:GetService("Selection"):Get() do
	local m = inst:IsA("Model") and inst or inst:FindFirstAncestorOfClass("Model")
	while m and not m:FindFirstChildOfClass("Humanoid") do m = m:FindFirstAncestorOfClass("Model") end
	if m then model = m break end
end
if not model then return "ERR:Select a character rig in Studio first (a model with a Humanoid). Avatar > Rig Builder > My Avatar inserts yours." end
local hum = model:FindFirstChildOfClass("Humanoid")
if hum.RigType ~= Enum.HumanoidRigType.R15 then return "ERR:That rig is R6. Only R15 rigs are supported so far." end
local parts, joints = {}, {}
local function joint(part0, part1, c0, c1)
	local a, b = { c0:GetComponents() }, { c1:GetComponents() }
	table.insert(joints, { part0 = part0.Name, part1 = part1.Name,
		c0 = { a[1], a[2], a[3] }, c0R = { table.unpack(a, 4, 12) },
		c1 = { b[1], b[2], b[3] }, c1R = { table.unpack(b, 4, 12) } })
end
for _, d in model:GetDescendants() do
	if d:IsA("BasePart") and d.Parent == model then parts[d.Name] = { d.Size.X, d.Size.Y, d.Size.Z } end
	-- Classic joints are Motor6Ds; newer avatars use AnimationConstraints, whose attachments hold the offsets.
	if d:IsA("Motor6D") and d.Part0 and d.Part1 then joint(d.Part0, d.Part1, d.C0, d.C1) end
	if d:IsA("AnimationConstraint") and d.Attachment0 and d.Attachment1 then
		joint(d.Attachment0.Parent, d.Attachment1.Parent, d.Attachment0.CFrame, d.Attachment1.CFrame)
	end
end
local description
local ok, desc = pcall(function() return hum:FindFirstChildOfClass("HumanoidDescription") or hum:GetAppliedDescription() end)
if ok and desc then
	description = {}
	for _, key in { "BodyTypeScale", "DepthScale", "HeadScale", "HeightScale", "ProportionScale", "WidthScale", "Head", "Torso", "LeftArm", "RightArm", "LeftLeg", "RightLeg" } do
		description[key] = desc[key]
	end
end
return game:GetService("HttpService"):JSONEncode({ name = model.Name, rig = { parts = parts, joints = joints, hipHeight = hum.HipHeight }, description = description })`;

const STOP_PLAYTEST = 'Roblox Studio is running a playtest. Stop it first.';
export const pushClips = (studioId, items, body = null) => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return luau(s, studioId, pushLuau(items, body));
});
export const previewClip = (studioId, anim, body = null) => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return luau(s, studioId, previewLuau(anim, anim.loop ? 3 : 2, body));
});
export const playtestClip = (studioId, anim, rig) => session(async s => {
  if (await inEdit(s, studioId) !== 'play') throw new Error('Start a playtest in Roblox Studio first (F5).');
  return luau(s, studioId, playtestLuau(anim, rig), 'Client');
});
export const listSaves = studioId => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return JSON.parse(await luau(s, studioId, LIST_SAVES));
});
export const pullSave = (studioId, fullName) => session(async s => JSON.parse(await luau(s, studioId, pullLuau(fullName))));
export const readRig = studioId => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return JSON.parse(await luau(s, studioId, READ_RIG));
});
