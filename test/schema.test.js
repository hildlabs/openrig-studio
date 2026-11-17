// The answer schema (src/core/schema.js) must accept what the system prompts show as the answer
// format, and stay within what structured output supports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { animationSchema } from '../src/core/schema.js';
import { RIG_R15, RIG_R6, partsOf } from '../src/core/rig.js';

// Just enough JSON Schema for this schema: type, enum, properties, required, additionalProperties, items, anyOf.
function errors(schema, value, at = '$') {
  if (schema.anyOf) return schema.anyOf.some(s => !errors(s, value, at).length) ? [] : [`${at}: matches no option`];
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type && schema.type !== type) return [`${at}: ${type} instead of ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${value} not allowed`];
  if (type === 'array') return value.flatMap((v, i) => errors(schema.items, v, `${at}[${i}]`));
  if (type !== 'object') return [];
  return [
    ...(schema.required ?? []).filter(k => !(k in value)).map(k => `${at}.${k}: missing`),
    ...Object.entries(value).flatMap(([k, v]) => (schema.properties[k] ? errors(schema.properties[k], v, `${at}.${k}`) : [`${at}.${k}: not allowed`])),
  ];
}
const answerExample = file => JSON.parse(readFileSync(new URL(`../prompts/${file}`, import.meta.url), 'utf8').split('## Answer format')[1].match(/```json\n([\s\S]*?)```/)[1]);

for (const [file, rig] of [['system.md', RIG_R15], ['system-r6.md', RIG_R6]]) {
  test(`the answer example in ${file} fits the ${rig.family ?? 'R15'} schema`, () => {
    assert.deepEqual(errors(animationSchema(rig), answerExample(file)), []);
  });
}

test('the schema names every joint of the rig and only uses what structured output supports', () => {
  for (const rig of [RIG_R15, RIG_R6]) {
    const schema = animationSchema(rig);
    assert.deepEqual(Object.keys(schema.properties.keyframes.items.properties.poses.properties), partsOf(rig));
    const walk = s => {
      if (s.type === 'object') { assert.equal(s.additionalProperties, false); Object.values(s.properties).forEach(walk); }
      if (s.items) walk(s.items);
      (s.anyOf ?? []).forEach(walk);
      for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) assert.ok(!(k in s), k);
    };
    walk(schema);
  }
  assert.ok(!('ik' in animationSchema(RIG_R6).properties.keyframes.items.properties), 'R6 has no IK targets');
});

test('a wrong answer is caught', () => {
  const bad = { name: 'x', loop: false, priority: 'Action', plan: [], notes: '', keyframes: [{ t: 0, poses: { Tail: { rot: [0, 0, 0] } } }] };
  assert.notDeepEqual(errors(animationSchema(RIG_R15), bad), []);
});
