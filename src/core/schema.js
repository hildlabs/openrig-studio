// JSON Schema of the answer the system prompts ask for (prompts/system*.md, "Answer format"), per rig:
// pose and target names are the rig's own. Sent as structured output where a provider supports it,
// so the answer is always valid JSON in the right shape. Value ranges (angles, offsets, vector
// length) stay with normalize(), which checks and reports them; structured output can't express them.
import { EASES, PRIORITIES } from './anim.js';
import { IK_CHAINS } from './ik.js';
import { partsOf } from './rig.js';

const vec = { type: 'array', items: { type: 'number' } };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function animationSchema(rig) {
  const pose = object({ rot: vec, pos: vec, ease: { type: 'string', enum: EASES } });
  const target = { anyOf: [vec, object({ pos: vec, space: { type: 'string', enum: ['world', 'body'] } }, ['pos'])] };
  const ends = rig.ik ? Object.keys(IK_CHAINS) : [];
  const keyframe = object({
    t: { type: 'number' },
    contact: { type: 'string', enum: ['ground', 'air'] },
    ...(ends.length ? { ik: object(Object.fromEntries(ends.map(e => [e, target]))) } : {}),
    poses: object(Object.fromEntries(partsOf(rig).map(p => [p, pose]))),
  }, ['t', 'poses']);
  return object({
    name: { type: 'string' },
    loop: { type: 'boolean' },
    priority: { type: 'string', enum: Object.keys(PRIORITIES) },
    plan: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    keyframes: { type: 'array', items: keyframe },
    events: { type: 'array', items: object({ t: { type: 'number' }, name: { type: 'string' }, value: { type: 'string' } }, ['t', 'name']) },
  }, ['name', 'loop', 'priority', 'plan', 'notes', 'keyframes']);
}
