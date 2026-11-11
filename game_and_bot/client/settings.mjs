// Settings, matching the original client's UserConfig: the same option names, groups,
// defaults, English labels, slider ranges, default hotkeys and colours (extracted from
// LWGA-NANO 250710A). Saved in localStorage.

export const Mod = { Shift: 256, Ctrl: 512, Alt: 1024 };

// ---- labels (the original's English text table) ------------------------------------------
export const TEXT = {
  hdrConfiguration: 'Configuration', hdrCellDisplay: 'Cell Display', hdrGameDisplay: 'Game Display',
  hdrBasicOperation: 'Basic Behavior', hdrControl: 'Operation', hdrColor: 'Color', hdrTheme: 'Theme', hdrWallpaper: 'Wallpaper',
  ShowName: 'Name', ShowMass: 'Mass', ShowSelfName: 'Self Name', MakeSelfWhite: 'White Self Skin', ShowSkin: 'Skin',
  ShowPelletSkin: 'Pellet Skin', ShowEnemySkin: 'Enemy Skin', ShowEnemyHint: 'Enemy Hint', ShowFood: 'Show Food',
  ShowCursorLine: 'Cursor Line', ShowMassMarker: 'Mass Marker', ShowSplitPrediction: 'Split Order Marker',
  ShowAutoSplitAlert: 'Auto Split Alert', ShowSplitIndicator: 'Split Indicator', ShowEatLimitMarker: 'Collision Marker',
  ShowCellDirectionMarker: 'Direction Marker', TogglePlayerTransparentCells: 'Toggle Transparent Cells',
  ShowRocketPunchMarker: 'Double Split Range', ShowTripKey: 'Show Trip Key', GlowingCells: 'Glowing Cells',
  GlowingNonPlayerCells: 'Glowing Non-player Cells', ReverseTextFill: 'Reverse Text Fill', NewTextStyle: 'Change Text Style',
  KeepLastSpectation: 'Keep Last Spectation', ShowChatBox: 'Chat', ShowLeaderboard: 'Scoreboard',
  ShowMap: 'Map',
  SimpleVirus: 'Simple Virus', VirusSplitHint: 'Virus Split Hint', VirusRangeHint: 'Virus Range Hint', ShowCoord: 'Field Coord',
  GlowingBorder: 'Glowing Border', SimplifiedMass: 'Simplified Mass Display', AutoHideText: 'Auto Hide Name/Mass',
  ShowClientStatus: 'Client Status', ShowServerStatus: 'Server Status', ShowSpecAimCursor: 'Show Cursor Line of Spec Target',
  ShowCircularName: 'Place Circular Name Label', MarkerLight: 'Marker Light', MarkerExtend: 'Marker Extend',
  ShowPlayerLog: 'Player Log', ShowTeamInfo: 'Show Team Info', ShowUnichatTripKey: 'Show Unichat Trip Key',
  OperationWithMouseButton: 'Enable Mouse Operation', SwapMouseButtons: 'Swap Mouse Buttons',
  Antialias: 'Antialias', HideMenuAfterDeath: 'Hide Menu After Death',
  hdrThisServer: 'Extra', MassDecay: 'Mass decay', MapWalls: 'Map walls',
  lbtResolution: 'Resolution', lbtRenderQuality: 'Render Quality', lbtRenderingTimeOffset: 'Rendering Time Offset',
  lbtCameraZoomSpeed: 'Camera Zoom Speed', lbtCameraMovementSpeed: 'Camera Movement Speed', lbtInterpolationType: 'Interpolation Type',
  lbtInterpolationResponce: 'Interpolation Speed', lbtMarkerOpacity: 'Marker Alpha', lbtMMarkerSize: 'Mass Marker Size',
  lbtSOMarkerSize: 'Split Order Marker Size', lbtAutoSplitAlertSize: 'Auto Split Alert Size', lbtTextSize: 'Text Size',
  lbtCursorLineThickness: 'Thickness of Cursor Line', lbtPlayerCellsAlpha: 'Player Cells Alpha', lbtPelletCellsAlpha: 'Pellet Cells Alpha',
  lbtAnotherSectionCellsAlpha: 'Another Section Cells Alpha', lbtFrameRate: 'Framerate',
  lbtResetConfig: 'Reset Config',
  hkSplit: 'Split', hkFeedOne: 'Single Feed', hkFeed: 'Continuous Feed', hkChangeUnit: 'Alter Operation Unit',
  hkDoubleSplit: 'Double Split', hkTripleSplit: 'Triple Split', hkQuadSplit: 'Full Split', hkSuperQuadSplit: 'Super Quad Split',
  hkInfernoSplit: 'Inferno Split', hkBSplit: 'Bug Split', hkTestSplit: 'Test Split', hk4xLineSplit: '4x Line Split Mode',
  hkSuspend: 'Stop Motion', hkToggleSuspend: 'Stop Motion(Toggle)', hkStartNewGame: 'Start New Game',
  hkToggelSpectateTarget: 'Spectation Mode',
  hkIncMass: 'Increase Mass', hkDecMass: 'Decrease Mass', hkClean: 'Clean Small Cells',
  hkSave: 'Save', hkLoad: 'Load',
  clGameBackground: 'Game Background', clGameForeground: 'Game Foreground', clFieldBorder: 'Field Outer Frame',
  clFieldCoords: 'Field Coordinate', clLeaderboardBack: 'LB Background', clLeaderboardHeader: 'LB Header',
  clMapBackground: 'Map Background', clChatBackground: 'Chat Background', clOverlayBack: 'Overlay Background',
  clMainPanelBack: 'Panel Background', clPanelForeground: 'Panel Foreground', clPanelHeader: 'Panel Header',
  clMainButtons: 'Main Buttons', clMenuButtons: 'Menu Buttons', clUiButtonActive: 'Buttons(Active)', clUiSymbols: 'UI Symbols',
  clChatSenderName: 'Chat Sender Name', clChatMessage: 'Chat Message', clChatTimeString: 'Chat Time Stamp',
  clCursorLine: 'Cursor Line', clVirusInnerFill: 'Virus Fill', clVirusOuterStroke: 'Virus Frame',
  clRedVirusOuterStroke: 'Red Virus Frame', clMiniVirusOuterStroke: 'Mini Virus Frame', clVirusRangeHint: 'Virus Range Hint',
  clMarkerA: 'Mass Marker Can Be Eaten By Double Split', clMarkerB: 'Mass Marker Can Be Eaten By Split',
  clMarkerC: 'Mass Marker Can Be Eaten If Overlapping', clMarkerD: "Mass Marker Can't Eat If Overlapping",
  clMarkerE: 'Mass Marker Can Eat If Overlapping', clMarkerF: 'Mass Marker Can Overlap If Split',
  clMarkerG: 'Mass Marker Can Eat By Split', clMarkerH: 'Mass Marker Can Eat By Double Split',
};

// ---- option groups, in the original's order ------------------------------------------------
export const CELL_DISPLAY = ['ShowName', 'ShowMass', 'ShowSelfName', 'MakeSelfWhite', 'ShowSkin', 'ShowEnemySkin',
  'ShowEnemyHint', 'ShowCursorLine', 'ShowMassMarker', 'ShowSplitPrediction', 'ShowAutoSplitAlert', 'ShowSplitIndicator',
  'ShowEatLimitMarker', 'ShowCellDirectionMarker', 'TogglePlayerTransparentCells', 'ShowRocketPunchMarker',
  'GlowingCells', 'GlowingNonPlayerCells', 'ReverseTextFill', 'NewTextStyle', 'KeepLastSpectation',
  'ShowChatBox', 'ShowLeaderboard', 'ShowMap'];
export const GAME_DISPLAY = ['ShowCoord', 'GlowingBorder', 'SimplifiedMass',
  'AutoHideText', 'ShowClientStatus', 'ShowServerStatus', 'ShowSpecAimCursor', 'ShowCircularName', 'MarkerLight', 'MarkerExtend',
  'ShowPlayerLog', 'ShowTeamInfo'];
export const BASIC = ['OperationWithMouseButton', 'SwapMouseButtons', 'Antialias', 'HideMenuAfterDeath'];
// Not in the original: options of this recreation's server (the Extra section).
export const THIS_SERVER = ['MassDecay', 'MapWalls'];
export const CONTROLS = ['hkSplit', 'hkFeedOne', 'hkFeed', 'hkChangeUnit', 'hkDoubleSplit', 'hkTripleSplit', 'hkQuadSplit',
  'hkSuperQuadSplit', 'hkInfernoSplit', 'hkTestSplit', 'hk4xLineSplit', 'hkSuspend', 'hkToggleSuspend',
  'hkStartNewGame', 'hkToggelSpectateTarget'];

// Sliders: [key, label, min, max, step, formatter]
const pct = (v) => `${Math.round(v * 1000)}‰`;
export const SLIDERS = [
  ['Resolution', 'lbtResolution', 0.75, 2, 0.05],
  ['RenderQuality', 'lbtRenderQuality', 0, 2, 1, (v) => ['Low', 'Mid', 'High'][v]],
  ['RenderingTimeOffset', 'lbtRenderingTimeOffset', 0, 1, 0.01],
  ['CameraZoomSpeed', 'lbtCameraZoomSpeed', 75, 125, 1],
  ['CameraMovementSpeed', 'lbtCameraMovementSpeed', -25, 75, 1],
  ['InterpolationType', 'lbtInterpolationType', 0, 2, 1, (v) => ['Classic', 'Linear', 'Preced'][v]],
  ['InterpolationSpeed', 'lbtInterpolationResponce', -0.5, 1, 0.01, (v) => String(parseInt(-50 + 100 * v, 10))],
  ['MarkerAlpha', 'lbtMarkerOpacity', 0, 1, 0.01],
  ['MMarkerSize', 'lbtMMarkerSize', 0, 0.2, 0.005, pct],
  ['SOMarkerSize', 'lbtSOMarkerSize', 0, 0.2, 0.005, pct],
  ['AutoSplitAlertSize', 'lbtAutoSplitAlertSize', 0, 0.2, 0.005, pct],
  ['TextSize', 'lbtTextSize', 0.2, 1.25, 0.01],
  ['CursorLineThickness', 'lbtCursorLineThickness', 1, 30, 1],
  ['PlayerCellsAlpha', 'lbtPlayerCellsAlpha', 0.25, 1, 0.05],
  ['PelletCellsAlpha', 'lbtPelletCellsAlpha', 0.25, 1, 0.05],
  ['AnotherSectionCellsAlpha', 'lbtAnotherSectionCellsAlpha', 0, 1, 0.05],
  ['FrameRateOption', 'lbtFrameRate', 0, 4, 1, (v) => `${FRAME_RATES[v]} fps`],
];
export const FRAME_RATES = [10, 15, 20, 30, 60];

// ---- defaults (the original's UserConfig constructor) --------------------------------------
const DEFAULTS = {
  ShowName: true, ShowMass: true, ShowSelfName: true, MakeSelfWhite: false, ShowSkin: true, ShowPelletSkin: false,
  ShowEnemySkin: true, ShowEnemyHint: true, ShowFood: true, ShowCursorLine: true, ShowMassMarker: false,
  ShowSplitPrediction: false, ShowAutoSplitAlert: false, ShowSplitIndicator: false, ShowEatLimitMarker: false,
  ShowCellDirectionMarker: false, TogglePlayerTransparentCells: true, ShowRocketPunchMarker: false, ShowTripKey: true,
  GlowingCells: false, GlowingNonPlayerCells: false, ReverseTextFill: false, NewTextStyle: true, KeepLastSpectation: false,
  ShowChatBox: true, ShowLeaderboard: true, ShowMap: true,
  SimpleVirus: true, VirusSplitHint: true, VirusRangeHint: false, ShowCoord: true, GlowingBorder: true, SimplifiedMass: true,
  AutoHideText: true, ShowClientStatus: true, ShowServerStatus: false, ShowSpecAimCursor: true, ShowCircularName: false,
  MarkerLight: true, MarkerExtend: true, ShowPlayerLog: false, ShowTeamInfo: false, ShowUnichatTripKey: true,
  OperationWithMouseButton: false, SwapMouseButtons: false, Antialias: true, HideMenuAfterDeath: false,
  MassDecay: true,
  MapWalls: false,
  SimulatedPing: 0,
  Resolution: 1, RenderQuality: 1, RenderingTimeOffset: 0, CameraZoomSpeed: 100, CameraMovementSpeed: 0,
  InterpolationType: 1, InterpolationSpeed: 0, MarkerAlpha: 1, MMarkerSize: 0.04, SOMarkerSize: 0.125,
  AutoSplitAlertSize: 0.025, TextSize: 1, CursorLineThickness: 5, PlayerCellsAlpha: 0.9, PelletCellsAlpha: 0.75,
  AnotherSectionCellsAlpha: 0.5, FrameRateOption: 4,
  fieldBackImageUri: '', fieldBackImageAlpha: 0.6, fieldBackImageDrawingMode2: false,
  panelBackImageUri: '', panelBackImageAlpha: 0.6,
};
const DEFAULT_CONTROLS = {
  hkSplit: 32, hkFeedOne: 87, hkFeed: 69, hkChangeUnit: 9, hkDoubleSplit: 84, hkTripleSplit: -1, hkQuadSplit: 71,
  hkSuperQuadSplit: -1, hkInfernoSplit: -1, hkTestSplit: -1, hk4xLineSplit: -1, hkSuspend: 83,
  hkToggleSuspend: 83 + Mod.Alt, hkStartNewGame: 90, hkToggelSpectateTarget: 81,
};
// The original binds N as both the toggle and the hold key for names.
const DEFAULT_TOGGLE_KEYS = { ShowName: 78 };
const DEFAULT_HOLD_KEYS = { ShowName: 78 };

// Colours are ARGB integers, as in the original's ColorDefs.
export const DEFAULT_COLORS = {
  clGameBackground: 0xff445588, clGameForeground: 0xffffffff, clFieldBorder: 0xffffffff, clFieldCoords: 0x88ffffff,
  clLeaderboardBack: 0x66000033, clLeaderboardHeader: 0xff00ffff, clMapBackground: 0x88000000, clChatBackground: 0x88000000,
  clOverlayBack: 0x44000000, clMainPanelBack: 0x88002288, clPanelForeground: 0xff00ffff, clPanelHeader: 0xff000044,
  clMainButtons: 0xffff0088, clMenuButtons: 0xff0088ff, clUiButtonActive: 0xff0000ff, clUiSymbols: 0xffffffff,
  clChatSenderName: 0xff0088ff, clChatMessage: 0xffffffff, clChatTimeString: 0xffaaaaaa, clCursorLine: 0xffffffff,
  clMarkerA: 0x00dd00bb, clMarkerB: 0x00ff0000, clMarkerC: 0x00ff6600, clMarkerD: 0x00ffff00,
  clMarkerE: 0x0000ffff, clMarkerF: 0x001e90ff, clMarkerG: 0x0020df20, clMarkerH: 0x00007d00,
};

// ---- key names (the original's HotKeyToText) -------------------------------------------------
const KEY_TEXT = { 32: 'Space', 13: 'Enter', 9: 'Tab', 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 96: 'Num0', 97: 'Num1',
  98: 'Num2', 99: 'Num3', 100: 'Num4', 101: 'Num5', 102: 'Num6', 103: 'Num7', 104: 'Num8', 105: 'Num9', 106: '*', 107: '+',
  109: '-', 110: '.', 111: '/', 112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8',
  120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12', 186: ':', 187: ';', 188: ',', 189: '-', 190: '.', 191: '/', 192: '@',
  219: '[', 220: '\\', 221: ']', 222: '^', 226: '\\' };
export function hotKeyText(code) {
  if (code == null || code <= 0) return '';
  const key = code & 255, mods = code - key;
  let prefix = '';
  if (mods & Mod.Shift) prefix = 'sft+';
  if (mods & Mod.Ctrl) prefix = 'ctl+';
  if (mods & Mod.Alt) prefix = 'alt+';
  return prefix + (KEY_TEXT[key] ?? String.fromCharCode(key));
}
export function hotKeyFromEvent(e) {
  let code = e.keyCode;
  if (e.ctrlKey) code += Mod.Ctrl;
  if (e.shiftKey) code += Mod.Shift;
  if (e.altKey) code += Mod.Alt;
  return code;
}

// ---- the store -------------------------------------------------------------------------------
const STORAGE_KEY = 'rec_settings_v1', COLOR_KEY = 'rec_colors_v1';
const clone = (o) => JSON.parse(JSON.stringify(o));
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

class Settings {
  constructor() {
    this.listeners = new Map();
    this.load();
  }
  load() {
    const saved = read(STORAGE_KEY) || {};
    this.values = { ...DEFAULTS, ...(saved.values || {}) };
    this.controls = { ...DEFAULT_CONTROLS };
    for (const [k, v] of Object.entries(saved.controls || {})) if (k in DEFAULT_CONTROLS) this.controls[k] = v; // removed hotkeys are dropped
    this.toggleKeys = { ...DEFAULT_TOGGLE_KEYS, ...(saved.toggleKeys || {}) };
    this.holdKeys = { ...DEFAULT_HOLD_KEYS, ...(saved.holdKeys || {}) };
    this.colors = { ...DEFAULT_COLORS, ...(read(COLOR_KEY) || {}) };
  }
  save() {
    write(STORAGE_KEY, { values: this.values, controls: this.controls, toggleKeys: this.toggleKeys, holdKeys: this.holdKeys });
    write(COLOR_KEY, this.colors);
  }
  get(k) { return this.values[k]; }
  set(k, v) { if (this.values[k] === v) return; this.values[k] = v; this.save(); this.emit(k); }
  toggle(k) { this.set(k, !this.values[k]); }
  setControl(k, code) { this.controls[k] = code; this.save(); this.emit('controls'); }
  setToggleKey(k, code) { this.toggleKeys[k] = code; this.save(); this.emit('hotkeys'); }
  setHoldKey(k, code) { this.holdKeys[k] = code; this.save(); this.emit('hotkeys'); }
  color(k) { return this.colors[k] >>> 0; }
  setColor(k, argb) { this.colors[k] = argb >>> 0; this.save(); this.emit('color:' + k); this.emit('colors'); }
  reset() {
    this.values = clone(DEFAULTS); this.controls = clone(DEFAULT_CONTROLS);
    this.toggleKeys = clone(DEFAULT_TOGGLE_KEYS); this.holdKeys = clone(DEFAULT_HOLD_KEYS);
    this.colors = clone(DEFAULT_COLORS); this.save(); this.emit('*');
  }
  // Import the original client's saved settings. Accepts what its localStorage holds:
  // lwga11_user_config (the settings, toggleHotKeys, holdHotKeys, controlHotKeys),
  // lwga11_color_defs (colours), or the {c, k} object from the console line in the README.
  // The original stores some numbers as strings ("2", "-0.14"); they are converted.
  importOriginal(text) {
    const parse = (t) => { if (t && typeof t === 'object') return t; try { return JSON.parse(String(t).trim()); } catch { return null; } };
    let data = parse(text);
    if (!data) throw new Error("that isn't the JSON the console line copies");
    const found = { values: 0, controls: 0, keys: 0, colors: 0 };
    const configs = [], colorSets = [];
    const take = (o) => {
      if (!o || typeof o !== 'object') return;
      if ('c' in o && typeof o.c === 'string') take(parse(o.c));
      if ('colors' in o) take(parse(o.colors));
      if ('controlHotKeys' in o || 'ShowName' in o || 'InterpolationType' in o) configs.push(o);
      if (Object.keys(o).some((k) => /^cl[A-Z]/.test(k))) colorSets.push(o);
    };
    take(data);
    const key = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : -1));
    for (const cfg of configs) {
      for (const [k, def] of Object.entries(DEFAULTS)) {
        if (!(k in cfg)) continue;
        const v = cfg[k];
        if (typeof def === 'boolean') this.values[k] = v === true || v === 1 || v === 'true' || v === '1';
        else if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n)) this.values[k] = n; else continue; }
        else this.values[k] = v == null ? '' : String(v);
        found.values++;
      }
      for (const [k, v] of Object.entries(cfg.controlHotKeys || {})) if (k in DEFAULT_CONTROLS) { this.controls[k] = key(v); found.controls++; }
      for (const [k, v] of Object.entries(cfg.toggleHotKeys || {})) if (k in DEFAULTS) { this.toggleKeys[k] = key(v); found.keys++; }
      for (const [k, v] of Object.entries(cfg.holdHotKeys || {})) if (k in DEFAULTS) { this.holdKeys[k] = key(v); found.keys++; }
    }
    for (const set of colorSets) for (const [k, v] of Object.entries(set)) {
      if (!(k in DEFAULT_COLORS)) continue;
      let n = null;
      if (typeof v === 'number') n = v >>> 0;
      else if (typeof v === 'string') { const h = v.trim().replace(/^#|^0x/i, ''); if (/^[0-9a-f]{6}$/i.test(h)) n = (0xff000000 | parseInt(h, 16)) >>> 0; else if (/^[0-9a-f]{8}$/i.test(h)) n = parseInt(h, 16) >>> 0; else if (Number.isFinite(Number(v))) n = Number(v) >>> 0; }
      if (n !== null) { this.colors[k] = n; found.colors++; }
    }
    if (!found.values && !found.controls && !found.colors) throw new Error('no settings found in that text');
    this.save(); this.emit('*');
    return found;
  }
  on(k, fn) { if (!this.listeners.has(k)) this.listeners.set(k, []); this.listeners.get(k).push(fn); }
  emit(k) {
    if (k === '*') { for (const fns of this.listeners.values()) for (const fn of fns) fn('*'); return; }
    for (const key of [k, '*']) for (const fn of this.listeners.get(key) || []) fn(k);
  }
}
export const settings = new Settings();

// ---- colour helpers (ARGB) -------------------------------------------------------------------
export const rgbOf = (argb) => argb & 0xffffff;
export const alphaOf = (argb) => ((argb >>> 24) & 255) / 255;
export const cssRgba = (argb) => `rgba(${(argb >> 16) & 255},${(argb >> 8) & 255},${argb & 255},${alphaOf(argb)})`;
export const cssRgb = (rgb) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return ((r * 255) << 16) | ((g * 255) << 8) | (b * 255);
}
