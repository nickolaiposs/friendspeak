// Appearance: color themes, font, text size and density. Stored per device in
// settings (store.js) and applied as CSS custom properties on <html>, which
// override the defaults at the top of style.css.
import { settings } from './store.js';
import { GOGH } from './gogh.js';

// Every color the UI is built from: the --<key> variables in style.css.
// Grouped and labelled for Settings → Appearance.
export const COLOR_GROUPS = [
  ['Backgrounds', [['bg-2', 'Chat'], ['bg-1', 'Sidebar and panels'], ['bg-0', 'Rail and inputs'], ['bg-3', 'Raised'], ['bg-hover', 'Hover'], ['bg-active', 'Pressed'], ['line', 'Borders']]],
  ['Text', [['text', 'Text'], ['text-strong', 'Headings'], ['muted', 'Muted'], ['link', 'Links']]],
  ['Accent', [['accent', 'Accent'], ['accent-hover', 'Accent hover'], ['accent-text', 'Accent text']]],
  ['Status', [['green', 'Online'], ['red', 'Danger'], ['yellow', 'Mentions']]],
];
export const COLOR_KEYS = COLOR_GROUPS.flatMap(([, colors]) => colors.map(([key]) => key));

export const THEMES = {
  dark: {
    name: 'Dark',
    colors: {
      'bg-0': '#0c0d10', 'bg-1': '#131519', 'bg-2': '#181a1f', 'bg-3': '#20232a', 'bg-hover': '#1e2127', 'bg-active': '#272b33', line: '#24272e',
      text: '#d4d7de', 'text-strong': '#f1f3f7', muted: '#8a909c', link: '#6db3ff',
      accent: '#8b6cf6', 'accent-hover': '#7753e8', 'accent-text': '#cbbcff',
      green: '#2fb36d', red: '#e5484d', yellow: '#f2b544',
    },
  },
  light: {
    name: 'Light',
    colors: {
      'bg-0': '#e3e5ea', 'bg-1': '#f1f2f5', 'bg-2': '#ffffff', 'bg-3': '#dcdfe5', 'bg-hover': '#e6e8ed', 'bg-active': '#d5d9e0', line: '#d9dce3',
      text: '#2e3338', 'text-strong': '#0b0d10', muted: '#5f6672', link: '#0b66d0',
      accent: '#6d4fe0', 'accent-hover': '#5a3bcf', 'accent-text': '#5335c4',
      green: '#1a8f52', red: '#d1343a', yellow: '#b87a00',
    },
  },
  contrast: {
    name: 'High contrast',
    colors: {
      'bg-0': '#000000', 'bg-1': '#000000', 'bg-2': '#000000', 'bg-3': '#1c1c1c', 'bg-hover': '#2a2a2a', 'bg-active': '#404040', line: '#a0a0a0',
      text: '#ffffff', 'text-strong': '#ffffff', muted: '#d2d2d2', link: '#7cc7ff',
      accent: '#ffd400', 'accent-hover': '#ffe566', 'accent-text': '#ffe566',
      green: '#3dff8f', red: '#ff6b6b', yellow: '#ffb000',
    },
  },
};

export const FONTS = {
  system: ['System', "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, 'Noto Sans', sans-serif"],
  classic: ['Classic sans', "'Helvetica Neue', Helvetica, Arial, 'Liberation Sans', sans-serif"],
  rounded: ['Rounded', "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', 'Nunito', 'Varela Round', 'Arial Rounded MT Bold', sans-serif"],
  serif: ['Serif', "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Noto Serif', serif"],
  mono: ['Monospace', "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace"],
  comic: ['Comic', "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', cursive"],
  custom: ['Custom…', ''],
};

// label, then the --density multiplier for row padding and line height
export const DENSITIES = { compact: ['Compact', 0.5], cozy: ['Cozy', 1], roomy: ['Roomy', 1.5] };

export const FONT_SIZE = { min: 12, max: 20, step: 0.5, base: 14.5 }; // px; base is what style.css is written for

// ---------- color math ----------

const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};
// WCAG relative luminance and contrast ratio
const luminance = (c) => {
  const [r, g, b] = rgb(c).map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const saturation = (c) => {
  const v = rgb(c);
  const [max, min] = [Math.max(...v), Math.min(...v)];
  return max ? (max - min) / max : 0;
};
const isDark = (bg) => luminance(bg) < 0.3;
// Push `c` toward `toward` until it reads against `bg`
const readable = (c, bg, min, toward) => {
  let out = c;
  for (let t = 0.05; t <= 1 && contrast(out, bg) < min; t += 0.05) out = mix(c, toward, t);
  return out;
};
// Text on a filled surface: white, as in the default theme, unless the fill is too light for it
const onColor = (fill) => (contrast('#ffffff', fill) >= 2.5 ? '#ffffff' : '#0c0d10');

// ---------- palettes ----------

// A full palette from a terminal scheme (a GOGH row): surfaces are shades of
// its background, and its colors are nudged until they read on that background.
export function paletteFromTerminal([, bg, fg, red, green, yellow, blue, magenta]) {
  const dark = luminance(bg) < luminance(fg);
  const pole = dark ? '#ffffff' : '#000000';
  const text = readable(fg, bg, 7, pole);
  // terminal "magenta" is the nearest thing to the app's purple accent; a few schemes have a grey there
  const accent = readable(saturation(magenta) > 0.15 ? magenta : blue, bg, 3, pole);
  return {
    'bg-0': dark ? mix(bg, '#000000', 0.3) : mix(bg, fg, 0.1),
    'bg-1': dark ? mix(bg, '#000000', 0.15) : mix(bg, fg, 0.05),
    'bg-2': bg,
    'bg-3': mix(bg, text, dark ? 0.1 : 0.13),
    'bg-hover': mix(bg, text, dark ? 0.07 : 0.08),
    'bg-active': mix(bg, text, dark ? 0.14 : 0.16),
    line: mix(bg, text, dark ? 0.13 : 0.15),
    text,
    'text-strong': mix(text, pole, 0.5),
    muted: readable(mix(text, bg, 0.42), bg, 4, pole),
    link: readable(blue, bg, 4.5, pole),
    accent,
    'accent-hover': mix(accent, '#000000', 0.14),
    'accent-text': readable(mix(accent, pole, 0.4), bg, 5.5, pole),
    green: readable(green, bg, 3, pole),
    red: readable(red, bg, 3, pole),
    yellow: readable(yellow, bg, 3, pole),
  };
}

export const SCHEMES = GOGH.map((row) => ({ name: row[0], colors: paletteFromTerminal(row) }));

// The colors in use: a built-in theme, or the custom palette (missing or bad entries fall back to dark)
export function paletteOf(st = settings.get()) {
  if (st.theme !== 'custom') return { ...(THEMES[st.theme] || THEMES.dark).colors };
  const colors = { ...THEMES.dark.colors };
  for (const k of COLOR_KEYS) if (HEX.test(st.themeColors?.[k])) colors[k] = st.themeColors[k].toLowerCase();
  return colors;
}

export const samePalette = (a, b) => COLOR_KEYS.every((k) => a[k] === b[k]);

// Set a palette's variables on an element: <html> for the app, or a .theme-scope preview
export function setColors(el, colors) {
  for (const k of COLOR_KEYS) el.style.setProperty('--' + k, colors[k]);
  for (const k of ['accent', 'green', 'red', 'yellow']) el.style.setProperty('--on-' + k, onColor(colors[k]));
  el.style.colorScheme = isDark(colors['bg-2']) ? 'dark' : 'light'; // native scrollbars and form controls
}

export function fontStack(st) {
  if (st.font !== 'custom') return (FONTS[st.font] || FONTS.system)[1];
  const name = String(st.fontCustom || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim();
  return (name ? `'${name}', ` : '') + FONTS.system[1];
}

export function applyAppearance(st = settings.get()) {
  const root = document.documentElement;
  const colors = paletteOf(st);
  setColors(root, colors);
  root.dataset.scheme = isDark(colors['bg-2']) ? 'dark' : 'light';
  const size = Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, +st.fontSize || FONT_SIZE.base));
  root.style.setProperty('--font-scale', size / FONT_SIZE.base);
  root.style.setProperty('--font', fontStack(st));
  root.style.setProperty('--density', (DENSITIES[st.density] || DENSITIES.cozy)[1]);
}
