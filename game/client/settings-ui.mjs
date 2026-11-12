// The settings panel: same sections and entries as the original's configuration panel.
// Cell Display rows have toggle + hold hotkeys, Game Display rows a toggle hotkey,
// Operation rows a single hotkey. Click a key box, then press a key; Backspace/Delete
// clears it, Esc cancels.
import {
  settings, TEXT, CELL_DISPLAY, GAME_DISPLAY, BASIC, THIS_SERVER, CONTROLS, SLIDERS, DEFAULT_COLORS,
  hotKeyText, hotKeyFromEvent, alphaOf, rgbOf, cssRgb,
} from '/settings.mjs';

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k in e) e[k] = v; else e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter((x) => x != null));
  return e;
};

// Only one hotkey box listens at a time.
let capturing = null;
export const isCapturingKey = () => capturing !== null;
addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if ([16, 17, 18].includes(e.keyCode)) return; // wait for the real key
  const { box, apply } = capturing; capturing = null; box.classList.remove('listening');
  if (e.key === 'Escape') { box.textContent = box.dataset.text; return; }
  apply(e.key === 'Backspace' || e.key === 'Delete' ? -1 : hotKeyFromEvent(e));
}, true);

function keyBox(get, set, title) {
  const box = el('button', { class: 'keybox', type: 'button', title });
  const refresh = () => { box.dataset.text = hotKeyText(get()) || '—'; box.textContent = box.dataset.text; };
  box.addEventListener('click', () => {
    if (capturing) { capturing.box.classList.remove('listening'); capturing.box.textContent = capturing.box.dataset.text; }
    box.textContent = 'press a key'; box.classList.add('listening');
    capturing = { box, apply: (code) => { set(code); refresh(); } };
  });
  refresh();
  settings.on('*', refresh); settings.on('hotkeys', refresh); settings.on('controls', refresh);
  return box;
}

function checkRow(key, { toggle = false, hold = false } = {}) {
  const cb = el('input', { type: 'checkbox', checked: !!settings.get(key), onchange: () => settings.set(key, cb.checked) });
  settings.on(key, () => (cb.checked = !!settings.get(key)));
  settings.on('*', () => (cb.checked = !!settings.get(key)));
  return el('div', { class: 'srow' },
    el('label', { class: 'slabel' }, cb, el('span', {}, TEXT[key] || key)),
    toggle ? keyBox(() => settings.toggleKeys[key], (c) => settings.setToggleKey(key, c), 'toggle key') : el('span', { class: 'keyspace' }),
    hold ? keyBox(() => settings.holdKeys[key], (c) => settings.setHoldKey(key, c), 'hold key') : el('span', { class: 'keyspace' }));
}

function sliderRow([key, label, min, max, step, fmt]) {
  const out = el('span', { class: 'sval' });
  const input = el('input', { type: 'range', min, max, step, value: settings.get(key) });
  const show = () => { const v = Number(settings.get(key)); input.value = v; out.textContent = fmt ? fmt(v) : String(+v.toFixed(3)); };
  input.addEventListener('input', () => { settings.set(key, Number(input.value)); show(); });
  settings.on(key, show); settings.on('*', show); show();
  return el('div', { class: 'srow slider' }, el('span', { class: 'slabel' }, TEXT[label] || label), input, out);
}

function colorRow(key) {
  const color = el('input', { type: 'color' });
  const alpha = el('input', { type: 'range', min: 0, max: 255, step: 1, title: 'alpha' });
  const swatch = el('span', { class: 'swatch' });
  const show = () => {
    const v = settings.color(key);
    color.value = cssRgb(rgbOf(v)); alpha.value = Math.round(alphaOf(v) * 255);
    swatch.style.background = `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alphaOf(v)})`;
  };
  const apply = () => {
    const rgb = parseInt(color.value.slice(1), 16), a = Number(alpha.value);
    settings.setColor(key, ((a << 24) | rgb) >>> 0); show();
  };
  color.addEventListener('input', apply); alpha.addEventListener('input', apply);
  settings.on('*', show); show();
  const isMarker = key.startsWith('clMarker');
  return el('div', { class: 'srow color' }, el('span', { class: 'slabel' }, TEXT[key] || key), swatch, color,
    isMarker ? el('span', { class: 'keyspace', title: 'marker colours ignore alpha' }) : alpha);
}

function textRow(key, label, placeholder = '') {
  const input = el('input', { type: 'text', value: settings.get(key) || '', placeholder });
  input.addEventListener('change', () => settings.set(key, input.value.trim()));
  settings.on('*', () => (input.value = settings.get(key) || ''));
  return el('div', { class: 'srow text' }, el('span', { class: 'slabel' }, label), input);
}

const section = (title, ...rows) => el('section', {}, el('h3', {}, title), ...rows);
const header = (...cols) => el('div', { class: 'srow shead' }, el('span', { class: 'slabel' }), ...cols.map((c) => el('span', { class: 'keyhead' }, c)));

export function buildSettingsPanel(root, { onClose }) {
  const tabs = {
    display: section(TEXT.hdrCellDisplay, header('toggle', 'hold'), ...CELL_DISPLAY.map((k) => checkRow(k, { toggle: true, hold: true }))),
    game: el('div', {},
      section(TEXT.hdrGameDisplay, header('toggle', ''), ...GAME_DISPLAY.map((k) => checkRow(k, { toggle: true }))),
      section(TEXT.hdrBasicOperation, ...BASIC.map((k) => checkRow(k))),
      section(TEXT.hdrThisServer, ...THIS_SERVER.map((k) => checkRow(k)),
        sliderRow(['SimulatedPing', 'Ping/ms', 0, 300, 1, (v) => (v ? `${v} ms` : 'off')]))),
    tuning: section(TEXT.hdrConfiguration, ...SLIDERS.map(sliderRow)),
    controls: section(TEXT.hdrControl, ...CONTROLS.map((k) => el('div', { class: 'srow' },
      el('span', { class: 'slabel' }, TEXT[k] || k),
      keyBox(() => settings.controls[k], (c) => settings.setControl(k, c), 'hotkey')))),
    colors: section(TEXT.hdrColor, ...Object.keys(DEFAULT_COLORS).map(colorRow)),
    theme: section(TEXT.hdrWallpaper,
      textRow('fieldBackImageUri', 'Field image URL', 'https://… or data:image/…'),
      sliderRow(['fieldBackImageAlpha', 'Field image alpha', 0, 1, 0.05]),
      checkRowPlain('fieldBackImageDrawingMode2', 'Stretch image beyond the field'),
      textRow('panelBackImageUri', 'Panel image URL', 'https://… or data:image/…'),
      sliderRow(['panelBackImageAlpha', 'Panel image alpha', 0, 1, 0.05])),
  };
  const names = { display: 'Cell Display', game: 'Game Display', tuning: 'Configuration', controls: 'Operation', colors: 'Color', theme: 'Theme' };
  const body = el('div', { class: 'sbody' });
  const bar = el('nav', { class: 'stabs' });
  const show = (id) => {
    body.replaceChildren(tabs[id]);
    for (const b of bar.children) b.classList.toggle('active', b.dataset.tab === id);
  };
  for (const id of Object.keys(tabs)) bar.append(el('button', { type: 'button', 'data-tab': id, onclick: () => show(id) }, names[id]));
  const reset = el('button', { type: 'button', class: 'danger', onclick: () => { if (confirm('Reset all settings, hotkeys and colours to the defaults?')) settings.reset(); } }, TEXT.lbtResetConfig);
  const close = el('button', { type: 'button', class: 'close', onclick: onClose, title: 'Close (Esc)' }, '×');
  // Import the settings you use on the original (senpai-agar.online/nano)
  const area = el('textarea', { class: 'importbox', rows: 4, placeholder: 'Ctrl+V here: the text the console command copied' });
  const status = el('span', { class: 'importstatus' });
  const importPane = el('div', { class: 'importpane hidden' },
    el('ol', { class: 'importsteps' },
      el('li', {}, 'In Chrome, open senpai-agar.online/nano (the original).'),
      el('li', {}, 'Press F12 and open the Console tab.'),
      el('li', {}, 'Paste this command there and press Enter. It copies your settings (nothing appears on screen):'),
    ),
    el('code', {}, "copy(JSON.stringify({c: localStorage.getItem('lwga11_user_config'), colors: localStorage.getItem('lwga11_color_defs')}))"),
    el('p', {}, '4. Come back here, click in the box below, press Ctrl+V, then Import.'),
    area,
    el('div', {}, el('button', { type: 'button', onclick: () => {
      try { const f = settings.importOriginal(area.value); status.textContent = `Imported ${f.values} settings, ${f.controls} hotkeys, ${f.keys} display keys, ${f.colors} colours.`; area.value = ''; }
      catch (err) { status.textContent = 'Could not import: ' + err.message; }
    } }, 'Import'), status));
  const importBtn = el('button', { type: 'button', onclick: () => importPane.classList.toggle('hidden') }, 'Import from original');
  root.replaceChildren(el('div', { class: 'spanel' },
    el('header', {}, el('span', {}, TEXT.hdrConfiguration), close), bar, body, importPane, el('footer', {}, importBtn, reset)));
  show('display');
}

function checkRowPlain(key, label) {
  const cb = el('input', { type: 'checkbox', checked: !!settings.get(key), onchange: () => settings.set(key, cb.checked) });
  settings.on('*', () => (cb.checked = !!settings.get(key)));
  return el('div', { class: 'srow' }, el('label', { class: 'slabel' }, cb, el('span', {}, label)));
}
