// Roblox Studio bridge through Roblox's built-in MCP server (StudioMCP, ships with Studio).
// Each action opens one stdio JSON-RPC session, runs its tool calls and closes it again.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadSettings } from './settings.js';
import { firstExisting, newestIn } from './process.js';
import { toLuauBuilder } from '../core/anim.js';

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

const seqFn = anim => `(function()\n${toLuauBuilder(anim)}\nend)`;
// The preview rig appears ~14 studs in front of the Studio camera, standing on whatever is below.
const ENSURE_RIG = `local function ensureRig()
	local rig = workspace:FindFirstChild("${RIG_NAME}")
	if rig then return rig end
	rig = game:GetService("Players"):CreateHumanoidModelFromDescription(Instance.new("HumanoidDescription"), Enum.HumanoidRigType.R15)
	rig.Name = "${RIG_NAME}"
	local cam = workspace.CurrentCamera
	local look = cam.CFrame.LookVector
	local flat = Vector3.new(look.X, 0, look.Z)
	if flat.Magnitude < 0.1 then flat = Vector3.new(0, 0, -1) end
	local spot = cam.CFrame.Position + flat.Unit * 14
	local hit = workspace:Raycast(spot + Vector3.new(0, 60, 0), Vector3.new(0, -500, 0))
	local ground = hit and hit.Position.Y or spot.Y - 3
	local y = ground + rig.Humanoid.HipHeight + rig.HumanoidRootPart.Size.Y / 2
	rig:PivotTo(CFrame.lookAt(Vector3.new(spot.X, y, spot.Z), Vector3.new(cam.CFrame.Position.X, y, cam.CFrame.Position.Z)))
	rig.HumanoidRootPart.Anchored = true
	rig.Parent = workspace
	return rig
end`;

// Saves clips where the Animation Editor keeps its saves: ServerStorage > RBX_ANIMSAVES > rig.
function pushLuau(anims) {
  return `${ENSURE_RIG}
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
for _, build in { ${anims.map(seqFn).join(',\n')} } do
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
function previewLuau(anim, loops) {
  return `local seq = ${seqFn(anim)}()
${ENSURE_RIG}
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
function playtestLuau(anim) {
  return `local player = game:GetService("Players").LocalPlayer
local char = player.Character or player.CharacterAdded:Wait()
local hum = char:WaitForChild("Humanoid", 10)
if not hum then return "ERR:The avatar has no Humanoid." end
if hum.RigType ~= Enum.HumanoidRigType.R15 then return "ERR:The playtest avatar is R6; this animation needs R15 (Game Settings > Avatar)." end
local animator = hum:FindFirstChildOfClass("Animator") or Instance.new("Animator", hum)
for _, tr in animator:GetPlayingAnimationTracks() do
	if tr.Animation and tr.Animation.Name == "OpenRigPreview" then tr:Stop(0.1) end
end
local a = Instance.new("Animation")
a.Name = "OpenRigPreview"
a.AnimationId = game:GetService("KeyframeSequenceProvider"):RegisterKeyframeSequence(${seqFn(anim)}())
local track = animator:LoadAnimation(a)
track.Priority = Enum.AnimationPriority.Action4
track.Looped = ${anim.loop}
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
const pullLuau = fullName => `local target = ${JSON.stringify(fullName)}
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

const STOP_PLAYTEST = 'Roblox Studio is running a playtest. Stop it first.';
export const pushClips = (studioId, anims) => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return luau(s, studioId, pushLuau(anims));
});
export const previewClip = (studioId, anim) => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return luau(s, studioId, previewLuau(anim, anim.loop ? 3 : 2));
});
export const playtestClip = (studioId, anim) => session(async s => {
  if (await inEdit(s, studioId) !== 'play') throw new Error('Start a playtest in Roblox Studio first (F5).');
  return luau(s, studioId, playtestLuau(anim), 'Client');
});
export const listSaves = studioId => session(async s => {
  if (await inEdit(s, studioId) === 'play') throw new Error(STOP_PLAYTEST);
  return JSON.parse(await luau(s, studioId, LIST_SAVES));
});
export const pullSave = (studioId, fullName) => session(async s => JSON.parse(await luau(s, studioId, pullLuau(fullName))));
