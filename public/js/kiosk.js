// Self-order kiosk (public). Orders land in the POS as open "Kiosk" orders to be paid at the counter.
import { api, h, $, money, pad, modal, toast, toastError, setCurrency, ORDER_TYPES } from './core.js';

const IDLE_MS = 90_000;
let menu = { categories: [], items: [] };
let catId = null;
let type = 'take_out';
let cart = [];
let idleTimer;
const optionIndex = new Map();

function resetIdle() {
  clearTimeout(idleTimer);
  if ($('#welcome').classList.contains('hidden')) idleTimer = setTimeout(startOver, IDLE_MS);
}
['click', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

function show(id) { for (const s of ['welcome', 'order', 'done']) $(`#${s}`).classList.toggle('hidden', s !== id); resetIdle(); }
function startOver() { cart = []; $$modalClose(); show('welcome'); }
function $$modalClose() { document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove()); }

async function loadMenu() {
  try {
    menu = await api('GET', '/api/public/menu');
    optionIndex.clear();
    for (const i of menu.items) for (const g of i.modifier_groups) for (const o of g.options) optionIndex.set(o.id, o);
    catId = catId && menu.categories.some((c) => c.id === catId) ? catId : menu.categories[0]?.id;
  } catch (e) { toastError(e); }
}

function renderCats() {
  $('#k-cats').innerHTML = menu.categories.map((c) => `<button data-c="${c.id}" class="${c.id === catId ? 'on' : ''}">${h(c.icon)} ${h(c.name)}</button>`).join('');
}
function renderItems() {
  $('#k-items').innerHTML = menu.items.filter((i) => i.category_id === catId).map((i) => `<button class="k-item ${i.available ? '' : 'off'}" data-i="${i.id}">
    <span class="ki">${h(i.icon)}</span><b>${h(i.name)}</b><span class="kd">${h(i.description)}</span><span class="kp">${i.available ? money(i.price) : 'Sold out'}</span></button>`).join('');
}
const unitOf = (l) => { const it = menu.items.find((i) => i.id === l.item_id); return it.price + l.modifiers.reduce((a, id) => a + (optionIndex.get(id)?.price_delta || 0), 0); };
function renderBar() {
  const n = cart.reduce((s, l) => s + l.qty, 0);
  $('#k-count').textContent = `${n} item${n === 1 ? '' : 's'}`;
  $('#k-total').textContent = money(cart.reduce((s, l) => s + unitOf(l) * l.qty, 0));
  $('#k-review').disabled = !n;
}

$('#k-cats').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { catId = Number(b.dataset.c); renderCats(); renderItems(); } };
$('#k-items').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) customize(menu.items.find((i) => i.id === Number(b.dataset.i))); };

function customize(item) {
  const chosen = new Map(item.modifier_groups.map((g) => [g.id, new Set(g.min_select > 0 ? g.options.filter((o) => o.is_default).map((o) => o.id) : [])]));
  let qty = 1;
  const body = document.createElement('div');
  body.className = 'col';
  const draw = () => {
    const unit = item.price + [...chosen.values()].flatMap((s) => [...s]).reduce((a, id) => a + optionIndex.get(id).price_delta, 0);
    body.innerHTML = `<div class="center" style="font-size:90px">${h(item.icon)}</div><div class="center"><h2>${h(item.name)}</h2><p class="muted">${h(item.description)}</p></div>
      ${item.modifier_groups.map((g) => `<div class="mod-group"><h4>${h(g.name)} ${g.min_select ? '<span class="badge brand">Required</span>' : '<span class="badge">Optional</span>'}</h4>
        <div class="opts">${g.options.map((o) => `<button class="opt ${chosen.get(g.id).has(o.id) ? 'on' : ''}" data-g="${g.id}" data-o="${o.id}"><b>${h(o.name)}</b><small>${o.price_delta ? `+${money(o.price_delta)}` : ''}</small></button>`).join('')}</div></div>`).join('')}
      <div class="qty-row" style="justify-content:center"><button class="btn xl icon-btn" data-q="-1" style="width:68px">−</button><b style="font-size:32px">${qty}</b><button class="btn xl icon-btn" data-q="1" style="width:68px">+</button></div>
      <button class="btn primary xl block" data-add>Add to order · ${money(unit * qty)}</button>`;
  };
  draw();
  const m = modal({ title: 'Make it yours', body, wide: true });
  body.onclick = (e) => {
    const o = e.target.closest('[data-o]');
    if (o) {
      const g = item.modifier_groups.find((x) => x.id === Number(o.dataset.g));
      const set = chosen.get(g.id);
      const id = Number(o.dataset.o);
      if (set.has(id)) { if (!(g.min_select && set.size <= g.min_select && g.max_select === 1)) set.delete(id); }
      else if (g.max_select === 1) { set.clear(); set.add(id); }
      else if (set.size < g.max_select) set.add(id);
      return draw();
    }
    const q = e.target.closest('[data-q]');
    if (q) { qty = Math.max(1, Math.min(20, qty + Number(q.dataset.q))); return draw(); }
    if (e.target.closest('[data-add]')) {
      for (const g of item.modifier_groups) if (chosen.get(g.id).size < g.min_select) return toast(`Please choose ${g.name}`, 'error');
      cart.push({ item_id: item.id, qty, modifiers: [...chosen.values()].flatMap((s) => [...s]) });
      m.close();
      renderBar();
      toast(`Added ${item.name}`, 'ok');
    }
  };
}

$('#k-review').onclick = () => {
  const body = document.createElement('div');
  body.className = 'col';
  const draw = () => {
    const total = cart.reduce((s, l) => s + unitOf(l) * l.qty, 0);
    body.innerHTML = `${cart.map((l, i) => { const it = menu.items.find((x) => x.id === l.item_id); return `<div class="row" style="border-bottom:1px dashed var(--border);padding:8px 0">
        <span style="font-size:36px">${h(it.icon)}</span><div class="grow"><b>${h(it.name)}</b><div class="muted small">${l.modifiers.map((id) => h(optionIndex.get(id)?.name)).join(', ')}</div></div>
        <div class="qty-row"><button class="btn icon-btn" data-dec="${i}">−</button><b>${l.qty}</b><button class="btn icon-btn" data-inc="${i}">+</button></div>
        <b class="num" style="min-width:90px;text-align:right">${money(unitOf(l) * l.qty)}</b></div>`; }).join('') || '<div class="empty">Your order is empty</div>'}
      <label class="field"><span>Your name (so we can call you) — optional</span><input class="input" id="k-name" maxlength="40" style="font-size:20px"></label>
      <div class="row" style="font-size:24px"><b class="grow">Total</b><b class="num">${money(total)}</b></div>
      <button class="btn primary xl block" data-submit ${cart.length ? '' : 'disabled'}>Place order — pay at counter</button>`;
  };
  draw();
  const m = modal({ title: `Your ${ORDER_TYPES[type]} order`, body, wide: true });
  body.onclick = async (e) => {
    const inc = e.target.closest('[data-inc]'); const dec = e.target.closest('[data-dec]');
    const name = $('#k-name', body)?.value;
    if (inc) { cart[Number(inc.dataset.inc)].qty += 1; draw(); $('#k-name', body).value = name; renderBar(); return; }
    if (dec) { const i = Number(dec.dataset.dec); if (--cart[i].qty <= 0) cart.splice(i, 1); draw(); $('#k-name', body).value = name; renderBar(); return; }
    const sub = e.target.closest('[data-submit]');
    if (sub) {
      sub.disabled = true;
      try {
        const r = await api('POST', '/api/kiosk/orders', { type, customer_name: name?.trim() || null, lines: cart });
        m.close();
        cart = [];
        renderBar();
        $('#k-num').textContent = pad(r.order_no);
        $('#k-due').textContent = money(r.total);
        show('done');
        setTimeout(() => { if (!$('#done').classList.contains('hidden')) startOver(); }, 25_000);
      } catch (err) { sub.disabled = false; toastError(err); await loadMenu(); renderItems(); }
    }
  };
};

document.querySelector('.k-choice').onclick = async (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  type = b.dataset.type;
  $('#k-type').textContent = ORDER_TYPES[type];
  await loadMenu();
  renderCats(); renderItems(); renderBar();
  show('order');
};
$('#k-start-over').onclick = startOver;
$('#k-new').onclick = startOver;

api('GET', '/api/public/config').then((c) => { setCurrency(c.currency_symbol); $('#kstore').textContent = `Welcome to ${c.store_name}!`; }).catch(() => {});
