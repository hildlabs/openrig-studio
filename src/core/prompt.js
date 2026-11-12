// System prompt for a custom rig: generated from the rig's own description (parts, joints,
// rest pose, limits, limbs) and filled into prompts/system-custom.md. Pure; no file access.
import { solve, point, rotV, mulR, rootCFrame } from './rig.js';
import { chainsOf } from './ik.js';

// For reading: Unicode minus, rounded. Never inside JSON, which wants real numbers (num below).
const f = (v, n = 2) => String(Math.round(v * 10 ** n) / 10 ** n).replace('-', '−');
const num = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n + 0; // + 0 turns -0 into 0
const json = p => JSON.stringify(p.map(v => num(v)));
const vec = v => `(${v.map(x => f(x)).join(', ')})`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// Where a world direction points, as a name when it is (nearly) an axis.
const CARDINAL = [[[1, 0, 0], '+X right'], [[-1, 0, 0], '−X left'], [[0, 1, 0], '+Y up'], [[0, -1, 0], '−Y down'], [[0, 0, 1], '+Z back'], [[0, 0, -1], '−Z front']];
function direction(d) {
  const hit = CARDINAL.find(([c]) => c[0] * d[0] + c[1] * d[1] + c[2] * d[2] > 0.92);
  return hit ? hit[1] : vec(d);
}

export function describeRig(rig) {
  const world = solve({}, rig, rootCFrame(rig));
  const body = rig.body, parts = Object.keys(rig.parts);
  const joint = Object.fromEntries(rig.joints.map(j => [j.part1, j]));
  const pivot = part => point(world[joint[part].part0], joint[part].c0);
  const chains = Object.values(chainsOf(rig));

  const partRows = ['| Part | Size | Centre | Joint pivot |', '|---|---|---|---|'];
  for (const n of parts) partRows.push(`| \`${n}\` | ${vec(rig.parts[n])} | ${vec(world[n].p)} | ${n === rig.root ? 'root part: never posed' : vec(pivot(n))} |`);

  const tree = [];
  const walk = (n, depth) => { tree.push(`${'  '.repeat(depth)}${n}${n === body ? '   ← body' : n === rig.root ? '   ← root part (fixed)' : ''}`); for (const j of rig.joints) if (j.part0 === n) walk(j.part1, depth + 1); };
  walk(rig.root, 0);

  const axes = ['| Joint | x axis points | y axis points | z axis points | x range | y range | z range |', '|---|---|---|---|---|---|---|'];
  for (const j of rig.joints) {
    const R = mulR(world[j.part0].R, j.c0R ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const lim = rig.limits[j.part1];
    axes.push(`| \`${j.part1}\` | ${[0, 1, 2].map(i => direction(rotV(R, [1, 0, 0].map((_, k) => (k === i ? 1 : 0))))).join(' | ')} | ${lim.map(([lo, hi]) => `${f(lo, 0)}…${f(hi, 0)}`).join(' | ')} |`);
  }

  const feet = rig.feet;
  const feetLine = feet.length
    ? `Parts that stand on the ground: ${feet.map(n => `\`${n}\``).join(', ')}.`
    : 'This rig has no feet to stand on, so nothing is grounded.';

  let ik;
  if (!chains.length) {
    ik = '## No hand and foot targets\n\nThis rig has no two-bone limbs the program can solve, so there is no `ik`: give angles.';
  } else {
    const rows = chains.map(c => {
      const [upper, lower] = c.joints;
      const reach = dist(pivot(upper), pivot(lower)) + dist(pivot(lower), pivot(c.end)) + dist(pivot(c.end), world[c.end].p);
      return `- \`${c.end}\`${c.foot ? ' (foot)' : ''}: moved by \`${upper}\` → \`${lower}\`, rest position ${vec(world[c.end].p)}, reaches at most ~${f(reach, 1)} studs from the pivot of \`${upper}\` ${vec(pivot(upper))}.`;
    });
    ik = `## Limb targets (IK), preferred where they fit

Instead of guessing angles for these limbs, give targets per keyframe:

\`\`\`json
{ "t": 0.6, "ik": { ${chains.slice(0, 2).map(c => `${JSON.stringify(c.end)}: ${json(world[c.end].p)}`).join(', ')} }, "poses": { } }
\`\`\`

${rows.join('\n')}

- A target is the centre of the end part${chains.some(c => c.foot) ? '; for feet it is the centre of the sole (y 0 = on the ground), and the foot is kept flat and points where the body points' : ''}.
- The program computes the two joints of the limb and overwrites their \`rot\`. It starts from the \`rot\` values you give for them, which is how you choose where bends point. Joints between the end part and its limb are solved on all three axes, so check the limit table.
- **Space:** ${chains.some(c => !c.foot) ? 'targets of non-foot limbs are **relative to the body** (rest-pose coordinates; they follow the body part\'s offset and rotation), ' : ''}${chains.some(c => c.foot) ? 'foot targets are **world positions** (ground y = 0): a foot stays planted while the body lowers, leans or turns. ' : ''}Override per target: \`"${chains[0].end}": { "pos": [x, y, z], "space": "world" }\` or \`"space": "body"\`.
${chains.some(c => c.foot) ? '- **Planted feet:** give a foot the same target in consecutive keyframes and it stays exactly in place in between (the program adds in-between keys).\n' : ''}- Unreachable targets and limbs inside the body are reported.`;
  }

  const ground = feet.length
    ? `The program shifts \`${body}.pos[1]\` in every keyframe so the lowest foot touches y = 0, so you don't need to compute body height for crouches or leans. In keyframes where **no foot touches the ground** (jumps, flight) set \`"contact": "air"\` and give the height yourself in \`${body}.pos[1]\`. Take-off and landing are ground keyframes.`
    : `Nothing is grounded: \`${body}.pos[1]\` is the height of the body above its rest position, exactly as you write it.`;

  // An example that only uses names of this rig.
  const second = rig.joints.find(j => j.part1 !== body && !chains.some(c => c.joints.includes(j.part1) || c.end === j.part1))?.part1 ?? rig.joints.find(j => j.part1 !== body)?.part1 ?? body;
  const ikEx = chains.length ? ` "ik": { ${JSON.stringify(chains[0].end)}: ${json(world[chains[0].end].p)} },` : '';
  const example = `{
  "name": "Short name",
  "loop": false,
  "priority": "Action",
  "plan": ["0.00–0.20 s: anticipation, the body sinks slightly", "0.20–0.45 s: the main motion"],
  "notes": "1–3 sentences: what the animation shows or what you changed.",
  "keyframes": [
    { "t": 0, "poses": { "${second}": { "rot": [0, 0, 0] } } },
    { "t": 0.2,${ikEx} "poses": { "${body}": { "pos": [0, -0.2, 0] }, "${second}": { "rot": [-10, 0, 0], "ease": "Out" } } },
    { "t": 0.45, "poses": { "${body}": { "pos": [0, 0, 0] }, "${second}": { "rot": [15, 0, 0] } } }
  ],
  "events": []
}`;

  return {
    NAME: rig.label ?? 'Custom rig', BODY: body, FEET_LINE: feetLine, PARTS: partRows.join('\n'), HIERARCHY: tree.join('\n'),
    AXES: axes.join('\n'), IK: ik, GROUND: ground, EXAMPLE: example, IK_INTRO: chains.length ? ', solves limb targets with IK' : '',
  };
}

// Template + description. Unknown placeholders are left alone so a typo shows up in tests.
export const customPrompt = (rig, template) => {
  const d = describeRig(rig);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(d, k) ? d[k] : m));
};
