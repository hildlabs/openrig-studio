// Library: folders, search, sort, filmstrip thumbnails, rename, star, bulk actions.
import { api, $, $$, esc, prefs, toast, menu, confirmDialog, promptDialog } from './api.js';
import { t, ago } from './i18n.js';
import { icon } from './icons.js';
import { openClip, studioId } from './app.js';

const L = { clips: [], folders: [], folder: prefs.get('libFolder', '__all'), query: '', sort: prefs.get('libSort', { key: 'updatedAt', dir: -1 }), selected: new Set(), editing: null };
let root;

export function mount(el) {
  root = el;
  root.innerHTML = `<div class="library">
    <nav class="folders" id="folders" aria-label="Folders"></nav>
    <section class="lib-main">
      <div class="lib-tools">
        <input type="search" id="libSearch">
        <span class="grow"></span>
        <button class="btn primary" id="libNew"></button>
      </div>
      <div class="bulk hidden" id="bulk"></div>
      <div class="lib-table" id="libTable"></div>
    </section>
  </div>`;
  $('#libSearch', root).addEventListener('input', e => { L.query = e.target.value.trim().toLowerCase(); renderTable(); });
  $('#libNew', root).addEventListener('click', async () => {
    const folder = L.folder.startsWith('__') ? '' : L.folder;
    const clip = await api('/api/clips', { method: 'POST', body: { name: t('clip.untitled'), folder, untitled: true } });
    openClip(clip.id);
  });
  $('#folders', root).addEventListener('click', onFolderClick);
  $('#libTable', root).addEventListener('click', onTableClick);
  $('#libTable', root).addEventListener('dblclick', e => {
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('input, button')) openClip(row.dataset.id);
  });
  $('#bulk', root).addEventListener('click', onBulk);
  relabel();
}
export function relabel() {
  $('#libSearch', root).placeholder = t('lib.search');
  $('#libNew', root).innerHTML = `${icon('plus')}${t('lib.new')}`;
  render();
}
export async function activate() {
  const data = await api('/api/clips');
  L.clips = data.clips;
  L.folders = data.folders;
  for (const id of [...L.selected]) if (!L.clips.some(c => c.id === id)) L.selected.delete(id);
  render();
}
function render() { renderFolders(); renderTable(); renderBulk(); }

function renderFolders() {
  const count = fn => L.clips.filter(fn).length;
  const item = (key, label, n, ico = 'folder') => `<div class="frow"><button class="f" data-folder="${esc(key)}" ${L.folder === key ? 'aria-current="true"' : ''}>${icon(ico)}<span>${esc(label)}</span><span class="count num">${n}</span></button>${key.startsWith('__') ? '' : `<button class="btn icon quiet fm" data-fmenu="${esc(key)}" title="${t('lib.renameFolder')}">${icon('edit')}</button>`}</div>`;
  $('#folders', root).innerHTML = item('__all', t('lib.all'), L.clips.length, 'library')
    + item('__starred', t('lib.starred'), count(c => c.starred), 'star')
    + item('__none', t('lib.unsorted'), count(c => !c.folder), 'folder')
    + '<div class="sep"></div>'
    + L.folders.map(f => item(f, f, count(c => c.folder === f))).join('')
    + `<button class="btn quiet new" data-act="newFolder">${icon('plus')}${t('lib.newFolder')}</button>`;
}
function visible() {
  let list = L.clips.filter(c => L.folder === '__all' || (L.folder === '__starred' ? c.starred : L.folder === '__none' ? !c.folder : c.folder === L.folder));
  if (L.query) list = list.filter(c => `${c.name} ${c.folder} ${c.model}`.toLowerCase().includes(L.query));
  const { key, dir } = L.sort;
  return list.sort((a, b) => {
    const va = a[key] ?? '', vb = b[key] ?? '';
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * dir;
  });
}
function renderTable() {
  const list = visible();
  const table = $('#libTable', root);
  if (!L.clips.length) { table.innerHTML = `<div class="lib-empty"><h2>${t('lib.empty')}</h2><p>${t('lib.emptyBody')}</p></div>`; return; }
  if (!list.length) { table.innerHTML = `<div class="lib-empty"><p>${t('lib.noMatch')}</p></div>`; return; }
  const th = (key, label) => `<th><button data-sort="${key}" ${L.sort.key === key ? `aria-sort="${L.sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${label}${L.sort.key === key ? (L.sort.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  const all = list.every(c => L.selected.has(c.id));
  table.innerHTML = `<table class="clips"><thead><tr>
      <th style="width:34px"><input type="checkbox" class="check" data-all ${all ? 'checked' : ''} aria-label="Select all"></th>
      <th style="width:340px"></th>${th('name', t('lib.col.name'))}${th('folder', t('lib.col.folder'))}${th('duration', t('lib.col.length'))}${th('model', t('lib.col.model'))}${th('updatedAt', t('lib.col.updated'))}<th style="width:80px"></th>
    </tr></thead><tbody>${list.map(c => `<tr data-id="${c.id}" class="${L.selected.has(c.id) ? 'sel' : ''}">
      <td><input type="checkbox" data-sel ${L.selected.has(c.id) ? 'checked' : ''} aria-label="${esc(c.name)}"></td>
      <td><img class="strip" loading="lazy" alt="" src="/api/clips/${c.id}/strip.png?u=${encodeURIComponent(c.updatedAt)}"></td>
      <td>${L.editing === c.id ? `<span class="clip-name"><input type="text" data-rename value="${esc(c.name)}"></span>` : `<div class="clip-name">${esc(c.name)}</div>`}
        <div class="clip-sub num">${t('clip.keys', { n: c.keyframes })}${c.loop ? ` · ${t('clip.loop')}` : ''}${c.rigName ? ` <span class="badge">${esc(c.rigName)}</span>` : ''}${c.issues ? ` <span class="badge warn">${t('history.findings', { n: c.issues })}</span>` : ''}</div></td>
      <td>${c.folder ? `<span class="badge">${esc(c.folder)}</span>` : ''}</td>
      <td class="num">${c.duration.toFixed(2)} s</td>
      <td class="clip-sub">${esc(c.model)}</td>
      <td class="clip-sub num">${ago(c.updatedAt)}</td>
      <td><button class="star${c.starred ? ' on' : ''}" data-star aria-pressed="${c.starred}" title="${t('lib.starred')}">${icon('star')}</button>
        <button class="btn icon quiet" data-edit title="${t('clip.rename')}">${icon('edit')}</button></td>
    </tr>`).join('')}</tbody></table>`;
  const input = $('[data-rename]', table);
  if (input) { input.focus(); input.select(); }
}
function renderBulk() {
  const bar = $('#bulk', root);
  const n = L.selected.size;
  bar.classList.toggle('hidden', !n);
  if (!n) return;
  bar.innerHTML = `<b class="num">${t('lib.selected', { n })}</b>
    <button class="btn" data-bulk="open" ${n === 1 ? '' : 'disabled'}>${icon('open')}${t('lib.open')}</button>
    <button class="btn" data-bulk="studio">${icon('studio')}${t('lib.toStudio')}</button>
    <button class="btn" data-bulk="export">${icon('download')}${t('lib.export')}</button>
    <button class="btn" data-bulk="move">${icon('folder')}${t('lib.moveTo')}</button>
    <button class="btn danger" data-bulk="delete">${icon('trash')}${t('actions.delete')}</button>
    <span class="grow"></span><button class="btn quiet" data-bulk="clear">${t('lib.clear')}</button>`;
}

async function onFolderClick(e) {
  const fm = e.target.closest('[data-fmenu]');
  if (fm) return folderMenu(fm, fm.dataset.fmenu);
  const f = e.target.closest('[data-folder]');
  if (f) { L.folder = f.dataset.folder; prefs.set('libFolder', L.folder); render(); return; }
  if (e.target.closest('[data-act=newFolder]')) {
    const name = await promptDialog(t('lib.newFolder'), '', t('set.save'));
    if (!name) return;
    L.folders = await api('/api/folders', { method: 'POST', body: { name } });
    L.folder = name;
    render();
  }
}
// Rename or remove a user folder.
function folderMenu(anchor, name) {
  menu(anchor, [{ value: 'rename', label: t('lib.renameFolder'), icon: icon('edit') }, { value: 'remove', label: t('lib.deleteFolder'), icon: icon('trash') }], async v => {
    if (v === 'rename') {
      const to = await promptDialog(t('lib.renameFolder'), name, t('set.save'));
      if (!to || to === name) return;
      await api('/api/folders', { method: 'PATCH', body: { from: name, to } });
      L.folder = to;
    } else {
      if (!await confirmDialog(t('lib.deleteFolderConfirm', { name }), t('lib.deleteFolder'))) return;
      await api(`/api/folders?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      L.folder = '__all';
    }
    activate();
  });
}
async function onTableClick(e) {
  const sort = e.target.closest('[data-sort]');
  if (sort) {
    const key = sort.dataset.sort;
    L.sort = { key, dir: L.sort.key === key ? -L.sort.dir : key === 'name' || key === 'folder' ? 1 : -1 };
    prefs.set('libSort', L.sort);
    return renderTable();
  }
  if (e.target.matches('[data-all]')) {
    const list = visible();
    if (e.target.checked) list.forEach(c => L.selected.add(c.id)); else list.forEach(c => L.selected.delete(c.id));
    renderTable(); renderBulk();
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('[data-star]')) {
    const clip = L.clips.find(c => c.id === id);
    clip.starred = !clip.starred;
    await api(`/api/clips/${id}`, { method: 'PATCH', body: { starred: clip.starred } });
    return render();
  }
  if (e.target.closest('[data-edit]')) { L.editing = id; renderTable(); wireRename(id); return; }
  if (e.target.closest('input')) {
    if (e.target.matches('[data-sel]')) { if (e.target.checked) L.selected.add(id); else L.selected.delete(id); row.classList.toggle('sel', e.target.checked); renderBulk(); }
    return;
  }
  if (L.selected.has(id) && L.selected.size === 1) L.selected.clear(); else { L.selected.clear(); L.selected.add(id); }
  renderTable(); renderBulk();
}
function wireRename(id) {
  const input = $('[data-rename]', root);
  if (!input) return;
  let done = false;
  const finish = async ok => {
    if (done) return;
    done = true;
    L.editing = null;
    const name = input.value.trim();
    if (ok && name && name !== L.clips.find(c => c.id === id)?.name) {
      await api(`/api/clips/${id}`, { method: 'PATCH', body: { name } });
      toast(t('done.renamed'));
      return activate();
    }
    renderTable();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}
async function onBulk(e) {
  const action = e.target.closest('[data-bulk]')?.dataset.bulk;
  if (!action) return;
  const ids = [...L.selected];
  try {
    if (action === 'clear') L.selected.clear();
    else if (action === 'open') return openClip(ids[0]);
    else if (action === 'export') location.href = `/api/export.rbxmx?ids=${ids.join(',')}`;
    else if (action === 'studio') {
      const id = studioId();
      if (!id) return;
      const { message } = await api('/api/studio/push', { method: 'POST', body: { studio: id, ids } });
      toast(t('done.push', { msg: message }));
    } else if (action === 'move') {
      const options = [{ value: '', label: t('lib.unsorted'), icon: icon('folder') }, ...L.folders.map(f => ({ value: f, label: f, icon: icon('folder') })), { value: '__new', label: t('lib.newFolder'), icon: icon('plus') }];
      return menu(e.target.closest('button'), options, async folder => {
        if (folder === '__new') { folder = await promptDialog(t('lib.newFolder'), '', t('set.save')); if (!folder) return; }
        await api('/api/bulk', { method: 'POST', body: { action: 'move', ids, folder } });
        toast(t('done.moved', { n: ids.length }));
        activate();
      });
    } else if (action === 'delete') {
      if (!await confirmDialog(t('dialog.confirmDelete', { n: ids.length }), t('dialog.delete'))) return;
      await api('/api/bulk', { method: 'POST', body: { action: 'delete', ids } });
      L.selected.clear();
      toast(t('done.deleted', { n: ids.length }));
      return activate();
    }
    render();
  } catch (err) { toast(err.message, true); }
}
