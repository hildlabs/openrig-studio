// Settings: providers (subscriptions and API keys), Roblox Studio connection, project style.
import { api, $, $$, esc, toast } from './api.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { store, reloadProviders, refreshStudios } from './app.js';

let root, view = null;

export function mount(el) {
  root = el;
  root.innerHTML = '<div class="settings"><div class="settings-inner" id="setInner"></div></div>';
  root.addEventListener('click', onClick);
  root.addEventListener('change', onToggle);
}
export async function activate() {
  view = await api('/api/settings');
  await reloadProviders();
  render();
}
export const relabel = () => { if (view) render(); };

function providerBlock(p) {
  const ok = p.available;
  const state = p.kind === 'api' ? (ok ? t('set.ready') : t('set.noKey')) : (ok ? t('set.ready') : t('set.notFound'));
  const how = {
    'claude-code': t('set.claudeHow', { cmd: '<code>claude</code>' }),
    codex: t('set.codexHow', { cmd: '<code>codex</code>' }),
    anthropic: t('set.anthropicHow'),
    openai: t('set.openaiHow'),
    compatible: t('set.compatibleHow'),
  }[p.id];
  const keyField = { anthropic: 'anthropicApiKey', openai: 'openaiApiKey', compatible: 'compatApiKey' }[p.id];
  const textRow = (field, placeholder) => `<div class="keyrow"><input type="text" data-field="${field}" value="${esc(view[field])}" placeholder="${placeholder}"><button class="btn" data-save="${field}">${t('set.save')}</button></div>`;
  const pathField = { 'claude-code': 'claudePath', codex: 'codexPath' }[p.id];
  return `<div class="provider">
    <div class="title">${esc(p.label)} <span class="badge">${p.kind === 'api' ? t('set.api') : t('set.subscription')}</span></div>
    <div class="state ${ok ? 'ok' : 'off'}">${ok ? icon('check') : ''} ${state}</div>
    <div class="how">${how}${p.detail ? `<br><span class="muted">${esc(p.detail)}</span>` : ''}</div>
    ${p.id === 'compatible' ? textRow('compatBaseUrl', t('set.compatUrl')) : ''}
    ${keyField ? `<div class="keyrow"><input type="password" autocomplete="off" data-field="${keyField}" placeholder="${esc(view[keyField] || t('set.keyPlaceholder'))}"><button class="btn" data-save="${keyField}">${t('set.save')}</button><button class="btn" data-test="${p.id}" ${ok ? '' : 'disabled'}>${t('set.test')}</button></div>` : ''}
    ${p.id === 'openai' ? textRow('openaiModels', t('set.openaiModels')) : ''}
    ${p.id === 'compatible' ? `${textRow('compatModels', t('set.compatModels'))}${textRow('compatMaxTokens', t('set.compatMaxTokens'))}
      <label class="check"><input type="checkbox" data-toggle="compatImages" ${view.compatImages === 'on' ? 'checked' : ''}><span>${t('set.compatImages')}</span></label>` : ''}
    ${pathField ? `<div class="keyrow"><input type="text" data-field="${pathField}" value="${esc(view[pathField])}" placeholder="${t('set.path')}"><button class="btn" data-save="${pathField}">${t('set.save')}</button><button class="btn" data-test="${p.id}" ${ok ? '' : 'disabled'}>${t('set.test')}</button></div>` : ''}
  </div>`;
}
function render() {
  $('#setInner', root).innerHTML = `<h1>${t('set.title')}</h1>
    <section class="card"><h2>${t('set.providers')}</h2><p>${t('set.providersBody')}</p>${store.providers.map(providerBlock).join('')}</section>
    <section class="card"><h2>${t('set.studio')}</h2><p>${t('set.studioBody')}</p>
      <p class="${view.studioMcpFound ? '' : 'muted'}">${view.studioMcpFound ? t('set.studioFound', { path: `<code>${esc(view.studioMcpFound)}</code>` }) : t('set.studioMissing')}</p>
      <div class="keyrow" style="display:flex;gap:8px"><input type="text" style="flex:1" data-field="studioMcpPath" value="${esc(view.studioMcpPath)}" placeholder="${t('set.path')}"><button class="btn" data-save="studioMcpPath">${t('set.save')}</button><button class="btn" data-studio>${icon('refresh')}${t('studio.refresh')}</button></div>
    </section>
    <section class="card"><h2>${t('set.style')}</h2><p>${t('set.styleBody')}</p>
      <textarea rows="3" data-field="style">${esc(view.style)}</textarea>
      <div><button class="btn" data-save="style">${t('set.save')}</button></div>
    </section>`;
}
async function onClick(e) {
  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) {
    const field = saveBtn.dataset.save;
    const input = $(`[data-field="${field}"]`, root);
    if (/ApiKey$/.test(field) && !input.value.trim()) return;
    try {
      view = await api('/api/settings', { method: 'PUT', body: { [field]: input.value } });
      await reloadProviders();
      toast(t('set.saved'));
      render();
    } catch (err) { toast(err.message, true); }
    return;
  }
  const test = e.target.closest('[data-test]');
  if (test) {
    test.disabled = true;
    try { toast(`${test.dataset.test}: ${(await api('/api/settings/test', { method: 'POST', body: { provider: test.dataset.test } })).message}`); }
    catch (err) { toast(err.message, true); }
    finally { test.disabled = false; }
    return;
  }
  if (e.target.closest('[data-studio]')) refreshStudios();
}
async function onToggle(e) {
  const field = e.target.dataset.toggle;
  if (!field) return;
  try {
    view = await api('/api/settings', { method: 'PUT', body: { [field]: e.target.checked ? 'on' : '' } });
    await reloadProviders();
    toast(t('set.saved'));
  } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
}
