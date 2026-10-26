// Benchmark: runs the fixed requests in bench/cases.json through the generation pipeline and
// measures the results (check findings, sliding feet, body use, expectations, time, tokens),
// so changes to the system prompt or the pipeline can be compared. Nothing is added to the
// library; every run is written to data/bench/<run>/ with clips, contact sheets and report.html.
//
//   npm run bench -- --list
//   npm run bench -- --engine claude-code:claude-sonnet-5-5:medium
//   npm run bench -- --engine anthropic:claude-opus-5-5:high --cases cheer,jump --runs 3
//   npm run bench -- --engine claude-code:claude-sonnet-5-5:medium --prompt prompts/test.md --baseline <run>
//   npm run bench -- --compare <runA> <runB>
//   npm run bench -- --replay <run>      (saved answers through the current pipeline, no model calls)
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { ROOT, DATA } from '../src/server/settings.js';
import { listProviders } from '../src/server/providers/index.js';
import { runPipeline, systemPrompt, engineLabel } from '../src/server/generate.js';
import { slug } from '../src/server/library.js';
import { duration, prepare } from '../src/core/anim.js';
import { formatIssues } from '../src/core/messages.js';
import { motionStats } from '../src/core/metrics.js';
import { renderSheet } from '../src/core/render.js';

const BENCH = path.join(DATA, 'bench');
const CASES = JSON.parse(readFileSync(path.join(ROOT, 'bench', 'cases.json'), 'utf8'));
const HELP = `Usage: npm run bench -- [options]

  --engine <provider:model:effort>  model to test, repeatable (see --list)
  --cases <id,id,...>               only these cases from bench/cases.json
  --runs <n>                        repeat every case n times (default 1)
  --parallel <n>                    requests at the same time (default 3)
  --prompt <file>                   system prompt to test instead of prompts/system.md
  --label <text>                    name for the run, e.g. "shorter-rules"
  --no-review                       skip the visual review pass
  --style                           append the project style from Settings
  --baseline <run>                  compare with an earlier run afterwards
  --compare <runA> <runB>           only compare two earlier runs
  --replay <run>                    put the saved model answers of a run through the
                                    current pipeline (no model calls) and compare
  --list                            show available engines and earlier runs`;

let opt, positionals;
try {
  ({ values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      engine: { type: 'string', multiple: true }, cases: { type: 'string' }, runs: { type: 'string', default: '1' },
      parallel: { type: 'string', default: '3' }, prompt: { type: 'string' }, label: { type: 'string' },
      'no-review': { type: 'boolean' }, style: { type: 'boolean' }, baseline: { type: 'string' },
      compare: { type: 'boolean' }, replay: { type: 'string' }, list: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) { fail(`${e.message}\n\n${HELP}`); }

function fail(message) { console.error(message); process.exit(1); }
const count = (value, name) => { const n = Number(value); if (!Number.isInteger(n) || n < 1) fail(`--${name} needs a whole number ≥ 1.`); return n; };
const avg = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : NaN);
const fmt = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '–');
const signed = (v, n = 1) => (Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(n) : '–');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const tokens = u => (u ? u.input + u.cached + u.output : 0);

function table(header, rows) {
  const width = header.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));
  const line = r => r.map((v, i) => (i ? String(v).padStart(width[i]) : String(v).padEnd(width[i]))).join('  ');
  return [line(header), width.map(w => '─'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

// ---------- Engines ----------
// provider:model:effort; model ids may contain ':' themselves, the effort is the last part.
function parseEngine(spec) {
  const parts = spec.split(':');
  return parts.length > 2
    ? { provider: parts[0], model: parts.slice(1, -1).join(':'), effort: parts.at(-1) }
    : { provider: parts[0], model: parts[1] ?? '', effort: '' };
}
function checkEngine(providers, engine) {
  const p = providers.find(x => x.id === engine.provider);
  if (!p) fail(`Unknown provider "${engine.provider}". Known: ${providers.map(x => x.id).join(', ')}.`);
  if (!p.available) fail(`${p.label} is not set up on this machine (see Settings in the app).`);
  const m = p.models.find(x => x.id === engine.model);
  if (engine.model && !m) fail(`${p.label} has no model "${engine.model}". Known: ${p.models.map(x => x.id).join(', ') || 'none'}.`);
  if (engine.effort && m?.efforts?.length && !m.efforts.includes(engine.effort)) fail(`${m.label ?? m.id} supports the efforts ${m.efforts.join(', ')}.`);
}

// ---------- Earlier runs ----------
function runDir(id) {
  const dir = existsSync(path.join(BENCH, id)) ? path.join(BENCH, id) : path.resolve(id);
  if (!existsSync(path.join(dir, 'results.json'))) fail(`No benchmark run "${id}" (looked in ${BENCH}).`);
  return dir;
}
function loadRun(id) {
  const dir = runDir(id);
  return { meta: JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')), results: JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')) };
}
function listRuns() {
  if (!existsSync(BENCH)) return [];
  return readdirSync(BENCH).filter(d => existsSync(path.join(BENCH, d, 'results.json'))).sort().map(d => ({ id: d, ...loadRun(d) }));
}

// ---------- Measuring one result ----------
function expectations(c, anim, metrics) {
  const misses = [];
  if (anim.loop !== Boolean(c.loop)) misses.push(c.loop ? 'not a loop' : 'loops but should not');
  if (c.air && metrics.airTime < 0.1) misses.push('never leaves the ground');
  const d = duration(anim);
  if (c.duration && (d < c.duration[0] || d > c.duration[1])) misses.push(`length ${fmt(d, 2)} s outside ${c.duration[0]}–${c.duration[1]} s`);
  if (!metrics.regions.includes('torso')) misses.push('torso does not move');
  return misses;
}
const codes = findings => findings.reduce((acc, f) => ({ ...acc, [f.code]: (acc[f.code] ?? 0) + 1 }), {});
// Score of a prepared result: check findings + missed expectations, lower is better.
const scoreOf = (r, c) => {
  const findings = [...r.warnings, ...r.issues];
  const metrics = motionStats(r.anim);
  const misses = expectations(c, r.anim, metrics);
  return { findings, misses, metrics, score: findings.length + misses.length };
};

// ---------- Summaries ----------
function summarize(results, cases) {
  const byCase = Object.fromEntries(cases.map(c => [c.id, c]));
  const engines = [...new Set(results.map(r => r.engine))];
  return engines.map(key => {
    const all = results.filter(r => r.engine === key), ok = all.filter(r => r.ok);
    const found = {};
    for (const r of ok) for (const [code, n] of Object.entries(r.findings)) found[code] = (found[code] ?? 0) + n;
    return {
      key, label: all[0].label, runs: all.length, failed: all.length - ok.length,
      score: avg(ok.map(r => r.score)),
      draftScore: avg(ok.filter(r => r.draftScore != null).map(r => r.draftScore)),
      clean: ok.length ? ok.filter(r => r.score === 0).length / ok.length : NaN,
      misses: ok.reduce((s, r) => s + r.misses.length, 0),
      slide: avg(ok.filter(r => !byCase[r.case]?.cycle).map(r => r.metrics.footSlide)),
      sink: Math.max(0, ...ok.map(r => r.metrics.footSink)),
      joints: avg(ok.map(r => r.metrics.activeJoints)),
      still: avg(ok.map(r => r.metrics.stillShare)),
      seconds: avg(all.map(r => r.seconds)),
      tokens: ok.reduce((s, r) => s + tokens(r.usage), 0),
      found: Object.entries(found).sort((a, b) => b[1] - a[1]),
    };
  });
}
function printSummary(results, cases) {
  const sums = summarize(results, cases);
  console.log('\n' + table(
    ['Engine', 'Runs', 'Failed', 'Score', 'Draft', 'Clean', 'Missed', 'Slide', 'Sink', 'Joints', 'Still', 'Sec', 'Tokens'],
    sums.map(s => [s.label, s.runs, s.failed, fmt(s.score, 2), fmt(s.draftScore, 2), `${fmt(s.clean * 100, 0)}%`, s.misses, fmt(s.slide, 2), fmt(s.sink, 2), fmt(s.joints), `${fmt(s.still * 100, 0)}%`, fmt(s.seconds, 0), s.tokens.toLocaleString('en')]),
  ));
  for (const s of sums) if (s.found.length) console.log(`${s.label}: ${s.found.map(([c, n]) => `${c} ${n}`).join(', ')}`);
  const engines = sums.map(s => s.key);
  console.log('\nScore per case (findings + missed expectations, average over runs; ✗ = failed)\n' + table(
    ['Case', ...sums.map(s => s.label)],
    cases.filter(c => results.some(r => r.case === c.id)).map(c => [c.id, ...engines.map(e => {
      const rs = results.filter(r => r.case === c.id && r.engine === e);
      const ok = rs.filter(r => r.ok), failed = rs.length - ok.length;
      return (ok.length ? fmt(avg(ok.map(r => r.score))) : '') + (failed ? ` ✗${failed > 1 ? failed : ''}` : '');
    })]),
  ));
  console.log(`
Score: check findings + missed expectations per clip (lower is better); Draft: the same before
the visual review. Clean: clips without any. Slide: studs planted feet slide (cycles excluded),
Sink: deepest foot in the ground. Joints: of 15 that move. Still: frames where nothing moves.`);
}

function printCompare(a, b) {
  const one = a.meta.engines.length === 1 && b.meta.engines.length === 1;
  const key = r => (one ? r.case : `${r.engine} ${r.case}`);
  const group = results => {
    const map = new Map();
    for (const r of results.filter(x => x.ok)) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
    return map;
  };
  const ga = group(a.results), gb = group(b.results);
  const keys = [...ga.keys()].filter(k => gb.has(k));
  if (!keys.length) fail('The two runs have no case (with the same engine) in common.');
  const stat = (rs, f) => avg(rs.map(f));
  const rows = keys.map(k => {
    const sa = stat(ga.get(k), r => r.score), sb = stat(gb.get(k), r => r.score);
    return [k, fmt(sa), fmt(sb), signed(sb - sa), signed(stat(gb.get(k), r => r.metrics.footSlide) - stat(ga.get(k), r => r.metrics.footSlide), 2)];
  });
  const total = f => [avg(keys.map(k => stat(ga.get(k), f))), avg(keys.map(k => stat(gb.get(k), f)))];
  const [sa, sb] = total(r => r.score), [la, lb] = total(r => r.metrics.footSlide);
  rows.push(['average', fmt(sa, 2), fmt(sb, 2), signed(sb - sa, 2), signed(lb - la, 2)]);
  const failed = run => run.results.filter(r => !r.ok).length;
  console.log(`\nA: ${a.meta.id} (${a.meta.engines.map(e => e.label).join(', ')}, prompt ${a.meta.prompt.sha})`);
  console.log(`B: ${b.meta.id} (${b.meta.engines.map(e => e.label).join(', ')}, prompt ${b.meta.prompt.sha})\n`);
  console.log(table(['Case', 'Score A', 'Score B', 'Δ Score', 'Δ Slide'], rows));
  console.log(`\nFailed: A ${failed(a)}, B ${failed(b)}. Negative Δ = B is better.${keys.length < 3 || a.meta.runs * b.meta.runs < 4 ? ' Few samples: models vary from run to run, use --runs 2 or more before trusting small differences.' : ''}`);
}

// ---------- Report ----------
function report(meta, results, cases) {
  const sums = summarize(results, cases);
  const head = ['Engine', 'Score', 'Draft', 'Clean', 'Failed', 'Missed', 'Slide', 'Joints', 'Sec', 'Tokens'];
  const rows = sums.map(s => [s.label, fmt(s.score, 2), fmt(s.draftScore, 2), `${fmt(s.clean * 100, 0)}%`, s.failed, s.misses, fmt(s.slide, 2), fmt(s.joints), fmt(s.seconds, 0), s.tokens.toLocaleString('en')]);
  const card = r => {
    if (!r.ok) return `<figure class="error"><figcaption><b>${esc(r.label)} · #${r.run}</b> · failed: ${esc(r.error)}</figcaption></figure>`;
    const items = [...r.misses.map(m => `<li class="miss">${esc(m)}</li>`), ...r.messages.map(m => `<li>${esc(m)}</li>`)].join('');
    return `<figure><img src="${esc(r.file)}.png" loading="lazy" alt="${esc(r.case)}"><figcaption><b>${esc(r.label)} · #${r.run}</b> · score ${r.score}${r.review === true ? ' · reviewed' : ''} · ${fmt(r.duration, 2)} s · ${r.keyframes} keys · slide ${fmt(r.metrics.footSlide, 2)}
      ${items ? `<ul>${items}</ul>` : ''}
      ${r.plan?.length ? `<details><summary>Plan</summary><ol>${r.plan.map(p => `<li>${esc(p)}</li>`).join('')}</ol></details>` : ''}</figcaption></figure>`;
  };
  const sections = cases.filter(c => results.some(r => r.case === c.id)).map(c => `<section><h2>${esc(c.id)}</h2><p class="prompt">${esc(c.prompt)}</p>${results.filter(r => r.case === c.id).map(card).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Benchmark ${esc(meta.id)}</title><style>
:root { --bg: #f6f6f4; --fg: #1d1d1b; --muted: #6b6b66; --card: #fff; --line: #ddd; --miss: #b4441c; }
@media (prefers-color-scheme: dark) { :root { --bg: #181817; --fg: #ecece8; --muted: #9a9a94; --card: #232322; --line: #3a3a38; --miss: #f08a5d; } }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
main { max-width: 1400px; margin: 0 auto; } h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 32px 0 2px; }
.meta, .prompt, figcaption { color: var(--muted); } .meta { margin: 0 0 16px; } .prompt { margin: 0 0 10px; font-style: italic; }
.scroll { overflow-x: auto; } table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; } th:first-child, td:first-child { text-align: left; }
figure { margin: 0 0 12px; padding: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
figure img { display: block; max-width: 100%; height: auto; border-radius: 4px; } figcaption { margin-top: 6px; }
figcaption b { color: var(--fg); } ul, ol { margin: 4px 0 0; padding-left: 20px; } .miss { color: var(--miss); }
.error figcaption { color: var(--miss); }
</style></head><body><main>
<h1>Benchmark ${esc(meta.id)}</h1>
<p class="meta">${esc(meta.createdAt)} · commit ${esc(meta.git.commit)}${meta.git.dirty ? ' (uncommitted changes)' : ''} · prompt ${esc(meta.prompt.file)} (${esc(meta.prompt.sha)}) · review ${meta.review ? 'on' : 'off'} · ${meta.runs} run${meta.runs > 1 ? 's' : ''} per case</p>
<div class="scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
${sections}
</main></body></html>`;
}

// ---------- Commands ----------
if (opt.help) { console.log(HELP); process.exit(0); }

if (opt.list) {
  const providers = await listProviders();
  console.log('Engines (--engine provider:model:effort):');
  for (const p of providers) {
    console.log(`\n${p.label}${p.available ? '' : ' (not set up)'}`);
    for (const m of p.models) console.log(`  ${p.id}:${m.id}${m.efforts?.length ? `:${m.efforts.join('|')}` : ''}`);
  }
  const runs = listRuns();
  if (runs.length) {
    console.log('\nEarlier runs (data/bench):');
    for (const r of runs) {
      const s = summarize(r.results, CASES);
      console.log(`  ${r.id}  ${s.map(x => `${x.label}: score ${fmt(x.score, 2)}`).join(' | ')}`);
    }
  }
  process.exit(0);
}

if (opt.compare) {
  if (positionals.length !== 2) fail('Usage: npm run bench -- --compare <runA> <runB>');
  printCompare(loadRun(positionals[0]), loadRun(positionals[1]));
  process.exit(0);
}


// ---------- Running ----------
const git = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
async function createRun(fields) {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const id = fields.label ? `${stamp}-${slug(fields.label)}` : stamp;
  const meta = { id, createdAt: d.toISOString(), git: { commit: git('rev-parse', '--short', 'HEAD') || 'unknown', dirty: Boolean(git('status', '--porcelain')) }, ...fields };
  const dir = path.join(BENCH, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1), 'utf8');
  return { dir, meta };
}

// Measures one pipeline output ({ result, draft, plan, notes, review, raw }) and writes its
// clip, the model's raw answers and a contact sheet.
async function record(dir, { c, n, engine }, out, extra) {
  const { anim } = out.result;
  const { findings, misses, metrics, score } = scoreOf(out.result, c);
  const file = `${engine.key}/${c.id}-${n}`;
  await mkdir(path.join(dir, engine.key), { recursive: true });
  await writeFile(path.join(dir, `${file}.png`), renderSheet(anim).png);
  await writeFile(path.join(dir, `${file}.json`), JSON.stringify({
    case: c, engine: engine.label, plan: out.plan, notes: out.notes, review: out.review, findings, misses, fixes: out.result.fixes, metrics,
    anim, draft: out.review?.applied ? out.draft.anim : undefined, raw: out.raw,
  }, null, 1), 'utf8');
  return {
    engine: engine.key, label: engine.label, case: c.id, run: n, ok: true, file, ...extra,
    score, draftScore: out.review ? scoreOf(out.draft, c).score : null,
    findings: codes(findings), messages: formatIssues(findings, 'en'), misses, metrics, review: out.review?.applied ?? null,
    duration: duration(anim), keyframes: anim.keyframes.length, plan: Array.isArray(out.plan) ? out.plan.map(String) : undefined,
  };
}

// Runs the tasks, saving results after every clip so an interrupted run can still be looked at
// and compared; then writes the report and prints the summary.
async function execute({ dir, meta }, tasks, parallel, fn, cases) {
  const results = [];
  let saving = Promise.resolve(), next = 0;
  const save = () => (saving = saving.then(() => writeFile(path.join(dir, 'results.json'), JSON.stringify(results, null, 1), 'utf8')));
  await Promise.all(Array.from({ length: Math.min(parallel, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      let r;
      try { r = await fn(task); } catch (e) { r = { engine: task.engine.key, label: task.engine.label, case: task.c.id, run: task.n, ok: false, error: e.message, seconds: 0 }; }
      results.push(r);
      const where = `[${String(results.length).padStart(String(tasks.length).length)}/${tasks.length}] ${r.label}  ${r.case} #${r.run}`;
      console.log(r.ok
        ? `${where}  score ${r.score}${r.draftScore != null ? ` (draft ${r.draftScore})` : ''}${Object.keys(r.findings).length ? `  [${Object.entries(r.findings).map(([k, v]) => `${k} ${v}`).join(', ')}]` : ''}${r.misses.length ? `  missed: ${r.misses.join('; ')}` : ''}  ${r.seconds}s`
        : `${where}  FAILED: ${r.error}`);
      await save();
    }
  }));
  // Same order as the tasks, independent of which request finished first.
  const order = r => tasks.findIndex(t => t.c.id === r.case && t.n === r.run && t.engine.key === r.engine);
  results.sort((a, b) => order(a) - order(b));
  await save();
  await writeFile(path.join(dir, 'report.html'), report(meta, results, cases), 'utf8');
  await saving;
  printSummary(results, cases);
  console.log(`\nReport with contact sheets: ${path.join(dir, 'report.html')}`);
  return results;
}

// ---------- Replay ----------
// Puts the saved model answers of an earlier run through the current pipeline: tests changes to
// IK, grounding, motion flow or the checks without asking any model again.
if (opt.replay) {
  const source = loadRun(opt.replay), sourceDir = runDir(opt.replay);
  const saved = r => JSON.parse(readFileSync(path.join(sourceDir, `${r.file}.json`), 'utf8'));
  const first = source.results.find(r => r.ok);
  if (!first) fail('That run has no finished clips.');
  if (!saved(first).raw) fail('That run was made before raw model answers were saved; it cannot be replayed.');
  const engines = source.meta.engines.map(e => ({ spec: { provider: e.provider, model: e.model, effort: e.effort }, label: e.label, key: e.key }));
  const caseOf = id => CASES.find(c => c.id === id);
  const tasks = source.results.map(r => ({ c: caseOf(r.case) ?? saved(r).case, n: r.run, engine: engines.find(e => e.key === r.engine), source: r }));
  const cases = [...new Map(tasks.map(t => [t.c.id, t.c])).values()];
  const run = await createRun({
    label: opt.label ?? `replay`, replayOf: source.meta.id, prompt: source.meta.prompt, review: source.meta.review, style: source.meta.style,
    runs: source.meta.runs, engines: source.meta.engines, cases: cases.map(c => c.id),
  });
  console.log(`Replay of ${source.meta.id} through the current pipeline: ${tasks.length} clips, no model calls.\nOutput: ${run.dir}\n`);
  const results = await execute(run, tasks, 8, async ({ c, n, engine, source: r }) => {
    if (!r.ok) return { ...r };
    const s = saved(r);
    const out = {
      result: prepare(structuredClone(s.raw.final), { literal: true }), draft: prepare(structuredClone(s.raw.draft), { literal: true }),
      plan: s.plan, notes: s.notes, review: s.review, raw: s.raw,
    };
    return record(run.dir, { c, n, engine }, out, { seconds: r.seconds, usage: r.usage });
  }, cases);
  printCompare(source, { meta: run.meta, results });
  process.exit(0);
}

// ---------- Live run ----------
if (!opt.engine?.length) fail(`Choose at least one --engine. Run "npm run bench -- --list" to see what is available.\n\n${HELP}`);
const runs = count(opt.runs, 'runs'), parallel = count(opt.parallel, 'parallel');
const wanted = opt.cases?.split(',').map(s => s.trim()).filter(Boolean);
const unknown = wanted?.filter(id => !CASES.some(c => c.id === id)) ?? [];
if (unknown.length) fail(`Unknown case${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Known: ${CASES.map(c => c.id).join(', ')}.`);
const cases = wanted ? CASES.filter(c => wanted.includes(c.id)) : CASES;
const baseline = opt.baseline ? loadRun(opt.baseline) : null;

const providers = await listProviders();
const engines = opt.engine.map(spec => {
  const engine = parseEngine(spec);
  checkEngine(providers, engine);
  const label = engineLabel(providers, engine);
  return { spec: engine, label, key: slug(label) };
});
if (new Set(engines.map(e => e.key)).size < engines.length) fail('The same engine is listed twice.');

const promptFile = opt.prompt ? path.resolve(opt.prompt) : path.join(ROOT, 'prompts', 'system.md');
if (!existsSync(promptFile)) fail(`No prompt file ${promptFile}.`);
const system = await systemPrompt('en', { base: readFileSync(promptFile, 'utf8'), withStyle: Boolean(opt.style) });
const review = !opt['no-review'];

const run = await createRun({
  label: opt.label ?? '',
  prompt: { file: path.relative(ROOT, promptFile).replaceAll('\\', '/'), sha: createHash('sha256').update(system).digest('hex').slice(0, 10) },
  review, style: Boolean(opt.style), runs, engines: engines.map(e => ({ ...e.spec, label: e.label, key: e.key })), cases: cases.map(c => c.id),
});
await writeFile(path.join(run.dir, 'system.md'), system, 'utf8');

const tasks = [];
for (const c of cases) for (let n = 1; n <= runs; n++) for (const engine of engines) tasks.push({ c, n, engine });
console.log(`Benchmark ${run.meta.id}: ${cases.length} case${cases.length > 1 ? 's' : ''} × ${engines.length} engine${engines.length > 1 ? 's' : ''} × ${runs} run${runs > 1 ? 's' : ''} = ${tasks.length} clips, review ${review ? 'on' : 'off'}, ${parallel} at a time.`);
console.log(`Output: ${run.dir}\n`);

const results = await execute(run, tasks, parallel, async task => {
  const started = Date.now();
  try {
    const out = await runPipeline({ clip: { chat: [] }, wish: task.c.prompt, mode: 'create', engine: task.engine.spec, system, review });
    return await record(run.dir, task, out, { seconds: Math.round((Date.now() - started) / 1000), usage: out.usage });
  } catch (e) {
    return { engine: task.engine.key, label: task.engine.label, case: task.c.id, run: task.n, ok: false, error: e.message, seconds: Math.round((Date.now() - started) / 1000) };
  }
}, cases);
if (baseline) printCompare(baseline, { meta: run.meta, results });
if (results.every(r => !r.ok)) process.exit(1);
