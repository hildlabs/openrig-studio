// App shell: tabs, shared state (providers, presets, Studio connection), language switch.
import { api, $, $$, esc, prefs, toast } from './api.js';
import { t, setLang, getLang } from './i18n.js';
import { icon } from './icons.js';
import * as editor from './editor.js';
import * as library from './library.js';
import * as compare from './compare.js';
import * as settings from './settings.js';

export const store = { providers: [], presets: [], studios: [], studioId: prefs.get('studio', ''), studioFound: true };
const views = { editor, library, compare, settings };
const mounted = new Set();
let current = null;

export function show(name) {
  if (!views[name]) name = 'editor';
  current = name;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  for (const key of Object.keys(views)) $(`#view-${key}`).classList.toggle('hidden', key !== name);
  if (!mounted.has(name)) { views[name].mount($(`#view-${name}`)); mounted.add(name); }
  views[name].activate?.();
  if (location.hash !== `#/${name}`) history.replaceState(null, '', `#/${name}`);
}
export async function openClip(id) {
  show('editor');
  await editor.open(id);
}

// Studio connection shown in the top bar and used by every Studio action.
export function studioId() {
  if (!store.studioId) { toast(t('err.selectStudio'), true); return null; }
  return store.studioId;
}
function renderStudio() {
  const sel = $('#studioSelect');
  const list = store.studios;
  sel.innerHTML = list.length
    ? list.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
    : `<option value="">${t(store.studioFound ? 'studio.none' : 'studio.unavailable')}</option>`;
  if (list.some(s => s.id === store.studioId)) sel.value = store.studioId;
  else store.studioId = list[0]?.id ?? '';
  $('#studioPill').classList.toggle('connected', Boolean(store.studioId));
}
export async function refreshStudios() {
  $('#studioSelect').innerHTML = `<option>${t('studio.searching')}</option>`;
  try {
    const { found, instances } = await api('/api/studio');
    store.studioFound = found;
    store.studios = instances;
  } catch { store.studios = []; }
  renderStudio();
}

function renderChrome() {
  for (const tab of $$('.tab')) tab.innerHTML = `${icon({ editor: 'editor', library: 'library', compare: 'compare', settings: 'settings' }[tab.dataset.view])}${t(`tab.${tab.dataset.view}`)}`;
  $('#studioRefresh').innerHTML = icon('refresh');
  $('#studioRefresh').title = t('studio.refresh');
  for (const b of $$('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
}

export async function reloadProviders() {
  store.providers = await api('/api/providers');
}

async function start() {
  renderChrome();
  for (const tab of $$('.tab')) tab.addEventListener('click', () => show(tab.dataset.view));
  $('#studioSelect').addEventListener('change', e => { store.studioId = e.target.value; prefs.set('studio', store.studioId); renderStudio(); });
  $('#studioRefresh').addEventListener('click', refreshStudios);
  for (const b of $$('.lang button')) b.addEventListener('click', () => {
    setLang(b.dataset.lang);
    renderChrome();
    renderStudio();
    for (const name of mounted) views[name].relabel?.();
  });
  try {
    [store.providers, store.presets] = await Promise.all([api('/api/providers'), api('/api/presets')]);
  } catch (e) { toast(e.message, true); }
  show(location.hash.replace('#/', '') || 'editor');
  addEventListener('hashchange', () => { const name = location.hash.replace('#/', ''); if (name !== current) show(name); });
  refreshStudios();
}
start();
