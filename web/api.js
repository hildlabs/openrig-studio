// Small helpers shared by all views: JSON API calls, toasts, dialogs, menus, local prefs.
import { t } from './i18n.js';

export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const kTok = n => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n ?? 0));

export const prefs = {
  get(key, fallback) { try { const v = localStorage.getItem(`openrig.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`openrig.${key}`, JSON.stringify(value)); } catch { /* storage blocked */ } },
};

export function toast(text, error = false) {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = text;
  box.append(el);
  setTimeout(() => el.remove(), error ? 7000 : 3500);
}

// Modal dialog; resolves with the value of the clicked [data-value] element or null.
export function dialog(html, { wide = false } = {}) {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'backdrop';
    back.innerHTML = `<div class="dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    const close = value => { back.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    back.addEventListener('click', e => {
      if (e.target === back) return close(null);
      const btn = e.target.closest('[data-value]');
      if (btn) close(btn.dataset.value === '__input' ? $('input', back)?.value ?? '' : btn.dataset.value);
    });
    back.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) close(e.target.value); });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    ($('input', back) ?? $('[data-value]', back))?.focus();
  });
}
export const confirmDialog = (text, okLabel) => dialog(`<p>${esc(text)}</p><div class="actions"><button class="btn" data-value="">${t('dialog.cancel')}</button><button class="btn primary" data-value="ok">${esc(okLabel)}</button></div>`).then(v => v === 'ok');
export const promptDialog = (title, value = '', okLabel = 'OK') => dialog(`<h3>${esc(title)}</h3><input type="text" value="${esc(value)}"><div class="actions"><button class="btn" data-value="">${t('dialog.cancel')}</button><button class="btn primary" data-value="__input">${esc(okLabel)}</button></div>`).then(v => (v ? v.trim() : null));

// Dropdown menu anchored to a button; items: [{ value, label, hint, icon }].
export function menu(anchor, items, onPick) {
  document.querySelector('.menu')?.remove();
  const el = document.createElement('div');
  el.className = 'menu';
  el.innerHTML = items.map(i => `<button data-value="${esc(i.value)}">${i.icon ?? '<span></span>'}<span>${esc(i.label)}</span>${i.hint ? `<small>${esc(i.hint)}</small>` : ''}</button>`).join('');
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${r.bottom + 6 + scrollY}px`;
  el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth))}px`;
  const off = e => { if (!el.contains(e.target) && e.target !== anchor) { el.remove(); document.removeEventListener('pointerdown', off); } };
  setTimeout(() => document.addEventListener('pointerdown', off));
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    el.remove();
    document.removeEventListener('pointerdown', off);
    onPick(b.dataset.value);
  });
}
