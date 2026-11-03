// 表示の設定。端末ごとに保存する

const KEY = 'ruby-reader-settings';

export const DEFAULTS = {
  writing: 'vertical',
  flow: 'page',
  fontSize: 18,
  lineHeight: 1.9,
  margin: 16,
  botenSize: 0.4,
  font: 'mincho',
  theme: 'auto',
  customFg: '#d8d6d0',
  customBg: '#16161a',
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても、この回の表示には使える
  }
}

export function applyTheme(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.writing = settings.writing;
  root.dataset.flow = settings.flow;
  root.style.setProperty('--font-size', `${settings.fontSize}px`);
  root.style.setProperty('--boten-size', settings.botenSize);
  root.style.setProperty('--reading-font', settings.font === 'gothic' ? 'var(--font-gothic)' : 'var(--font-mincho)');
  if (settings.theme === 'custom') {
    root.style.setProperty('--bg', settings.customBg);
    root.style.setProperty('--fg', settings.customFg);
  } else {
    root.style.removeProperty('--bg');
    root.style.removeProperty('--fg');
  }
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
