// 画面の組み立て: 一覧、本文、設定、ファイルの取り込み
import { decodeBytes } from './decode.js';
import { DropboxClient } from './dropbox.js';
import { compareNames, planIncoming } from './library.js';
import { Reader } from './reader.js';
import { detectBracket, splitLines } from './ruby.js';
import { applyTheme, loadSettings, saveSettings } from './settings.js';
import * as store from './storage.js';

const $ = (id) => document.getElementById(id);
const LAST_DOC_KEY = 'ruby-reader-last-doc';
const HEADING = /^[\s　]*(\d+|第.{1,8}[章話部節])[\s　]*$/;
const TAP_MOVE_LIMIT = 10;
const SWIPE_MIN = 40;
const LONG_PRESS_MS = 500;
const SELECT_PRESS_MS = 350; // これより長く押していれば、文字の選択を許す（Android の長押しの判定より短くする）

const settings = loadSettings();
let current = null; // 開いている文書
let currentBook = null;
let saveTimer = 0;

const reader = new Reader({
  frame: $('frame'),
  scroller: $('scroller'),
  content: $('content'),
  onChange: () => {
    updateIndicator();
    schedulePositionSave();
  },
});

// ---- 小物

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 再開の情報が残らないだけ
  }
}

let toastTimer = 0;
function toast(message, ms = 3500) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const displayName = (name) => name.replace(/\.txt$/i, '');

// ---- 取り込み

async function ingest(files) {
  const docs = await store.getDocs();
  const books = await store.getBooks();
  const plan = planIncoming(files, docs, books, () => crypto.randomUUID());
  const now = Date.now();
  const byId = new Map(docs.map((d) => [d.id, d]));
  const docWrites = [
    ...plan.updates.map((u) => ({ ...byId.get(u.id), text: u.text, bookId: u.bookId, receivedAt: now })),
    ...plan.creates.map((c) => ({ ...c, receivedAt: now, openedAt: 0, position: null, progress: 0 })),
  ];
  const bookWrites = plan.newBook ? [{ ...plan.newBook, createdAt: now, lastDocId: plan.openId, bracket: 'auto' }] : [];
  await store.saveAll(docWrites, bookWrites);
  navigator.storage?.persist?.();

  if (plan.creates.length && plan.updates.length) toast(`新しい${plan.creates.length}件を追加し、${plan.updates.length}件を更新しました`);
  else if (plan.updates.length) toast(plan.changed ? '内容を新しくしました。読んでいた位置に戻ります' : '内容は前回と同じです');
  else if (plan.creates.length > 1) toast(`${plan.creates.length}件のファイルを受け取りました`);
  return plan.openId;
}

async function readFiles(fileLikes) {
  const results = [];
  for (const f of fileLikes) {
    try {
      results.push({ name: f.name, text: decodeBytes(new Uint8Array(await f.blob.arrayBuffer())) });
    } catch (e) {
      toast(`${f.name}: ${e.message}`);
    }
  }
  return results;
}

async function processInbox() {
  const entries = await store.takeInbox();
  if (!entries.length) return null;
  const fileEntries = entries.filter((e) => e.kind === 'file');
  if (fileEntries.length) {
    const files = await readFiles(fileEntries);
    return files.length ? ingest(files) : null;
  }
  const { title, text, url } = entries[0];
  const body = (text ?? '').trim();
  if (url || /^https?:\/\/\S+$/.test(body) || /https?:\/\//.test(body)) {
    toast('届いたのはリンクでした。Dropboxの共有では「エクスポート」を選ぶとファイルを送れます', 8000);
    return null;
  }
  if (!body) return null;
  return ingest([{ name: title || '共有されたテキスト', text: body }]);
}

async function openPicked(list) {
  const files = await readFiles([...list].map((file) => ({ name: file.name, blob: file })));
  if (!files.length) return;
  const id = await ingest(files);
  await openDoc(id);
}

// ---- Dropbox

const dropbox = new DropboxClient({ storage: { get: storageGet, set: storageSet } });

function updateDropboxRow() {
  $('dropbox').hidden = !dropbox.configured;
  $('dropbox-status').textContent = dropbox.connected ? 'Dropboxと接続済み' : 'Dropboxと未接続';
  $('dropbox-toggle').textContent = dropbox.connected ? '切断' : '接続';
}

async function toggleDropbox() {
  if (!dropbox.connected) {
    location.assign(await dropbox.authorizeUrl(new URL('./', location.href).href));
    return;
  }
  if (!confirm('Dropboxとの接続を切りますか？（端末に保存したファイルは残ります）')) return;
  await dropbox.disconnect();
  updateDropboxRow();
}

// 認証の画面から戻ってきたときの処理。一覧の取得まで試して、接続できたことを確かめる
async function finishDropboxAuth(params) {
  try {
    if (!(await dropbox.handleRedirect(params))) return;
    const entries = await dropbox.listFolder('');
    toast(`Dropboxに接続しました（最上位に${entries.length}件）`, 8000);
  } catch (e) {
    console.error(e);
    toast(e.message, 8000);
  }
}

// ---- 一覧

function progressLabel(progress) {
  return `${Math.round((progress ?? 0) * 100)}%`;
}

async function showLibrary() {
  await savePositionNow();
  current = null;
  currentBook = null;
  $('reader').hidden = true;
  $('library').hidden = false;
  document.title = 'ルビリーダー';
  updateDropboxRow();

  const docs = await store.getDocs();
  const books = await store.getBooks();
  const list = $('doc-list');
  list.textContent = '';
  $('empty').hidden = docs.length > 0;

  const rows = [];
  for (const d of docs) {
    if (!d.bookId) rows.push({ name: displayName(d.name), meta: `${progressLabel(d.progress)} ・ 受信 ${formatDate(d.receivedAt)}`, sort: d.openedAt || d.receivedAt, open: d.id, removeIds: [d.id] });
  }
  for (const b of books) {
    const members = docs.filter((d) => d.bookId === b.id);
    if (!members.length) continue;
    const latest = Math.max(...members.map((d) => d.receivedAt));
    const opened = Math.max(...members.map((d) => d.openedAt || 0));
    const first = [...members].sort((x, y) => compareNames(x.name, y.name))[0];
    rows.push({
      name: b.title,
      meta: `${members.length}ファイル ・ 受信 ${formatDate(latest)}`,
      sort: opened || latest,
      open: members.some((d) => d.id === b.lastDocId) ? b.lastDocId : first.id,
      removeIds: members.map((d) => d.id),
      bookId: b.id,
    });
  }
  rows.sort((a, b) => b.sort - a.sort);

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'doc-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'doc-open';
    const name = document.createElement('div');
    name.className = 'doc-name';
    name.textContent = row.name;
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    meta.textContent = row.meta;
    open.append(name, meta);
    open.addEventListener('click', () => openDoc(row.open));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'doc-delete';
    del.textContent = '削除';
    del.setAttribute('aria-label', `${row.name}を削除`);
    del.addEventListener('click', async () => {
      if (!confirm(`「${row.name}」をこの端末から削除しますか？（Dropboxのファイルは消えません）`)) return;
      await store.removeDocs(row.removeIds, row.bookId);
      if (row.removeIds.includes(storageGet(LAST_DOC_KEY))) storageSet(LAST_DOC_KEY, null);
      showLibrary();
    });
    li.append(open, del);
    list.append(li);
  }
}

// ---- 本文

function effectiveBracket(override, text) {
  if (override === 'none') return null;
  if (override === '《' || override === '｛') return override;
  return detectBracket(text);
}

async function bookDocs() {
  if (!current?.bookId) return [];
  const docs = await store.getDocs();
  return docs.filter((d) => d.bookId === current.bookId).sort((a, b) => compareNames(a.name, b.name));
}

async function renderCurrent() {
  const members = await bookDocs();
  const override = currentBook ? currentBook.bracket : current.bracket;
  const source = members.length ? members.map((d) => d.text).join('\n') : current.text;
  const bracket = effectiveBracket(override ?? 'auto', source);
  current.detected = bracket;
  reader.setText(current.text, bracket);
  reader.layout(settings);
}

async function openDoc(id, { atEnd = false, pushHistory = true } = {}) {
  await savePositionNow();
  const doc = await store.getDoc(id);
  if (!doc) return showLibrary();
  current = doc;
  current.openedAt = Date.now();
  currentBook = doc.bookId ? ((await store.getBooks()).find((b) => b.id === doc.bookId) ?? null) : null;
  storageSet(LAST_DOC_KEY, id);

  $('library').hidden = true;
  $('reader').hidden = false;
  hideBars();
  $('title').textContent = displayName(doc.name);
  $('received').textContent = `受信 ${formatDate(doc.receivedAt)}`;
  document.title = displayName(doc.name);

  await renderCurrent();
  reader.restore(doc.position, { atEnd });
  await updateChapterButtons();
  if (pushHistory && history.state?.view !== 'reader') history.pushState({ view: 'reader' }, '');
  if (currentBook) {
    currentBook.lastDocId = id;
    await store.putBook(currentBook);
  }
  await savePositionNow();
}

function updateIndicator() {
  const el = $('page-indicator');
  if (reader.settings?.flow === 'page') el.textContent = `${reader.page + 1} / ${reader.pageCount}`;
  else el.textContent = `${Math.round(reader.fraction * 100)}%`;
  $('slider').value = String(Math.round(reader.fraction * 1000));
}

function schedulePositionSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePositionNow, 400);
}

async function savePositionNow() {
  clearTimeout(saveTimer);
  if (!current) return;
  current.position = reader.capture();
  current.progress = reader.fraction;
  const { detected, ...doc } = current;
  await store.putDoc(doc);
}

// レイアウトが変わるときは、先頭の文字が変わらないようにする
function relayout() {
  if (!current) return;
  const pos = reader.capture();
  reader.layout(settings);
  reader.restore(pos);
}

async function neighbor(step) {
  const members = await bookDocs();
  const i = members.findIndex((d) => d.id === current.id);
  return i < 0 ? null : (members[i + step] ?? null);
}

async function updateChapterButtons() {
  const inBook = Boolean(current.bookId);
  $('next-chapter').hidden = !inBook;
  $('prev-chapter').hidden = !inBook;
  if (inBook) {
    $('next-chapter').disabled = !(await neighbor(1));
    $('prev-chapter').disabled = !(await neighbor(-1));
  }
}

async function moveChapter(step) {
  const target = await neighbor(step);
  if (!target) {
    toast(step > 0 ? '最後のファイルです' : '最初のファイルです', 1500);
    return;
  }
  // 順に読み進めるときは章の端から始める（前の章へ戻るときは章の終わりへ）
  if (step > 0) await store.putDoc({ ...target, position: null });
  await openDoc(target.id, { atEnd: step < 0 });
}

function forward() {
  if (reader.next()) return;
  if (current.bookId) moveChapter(1);
  else toast('最後のページです', 1500);
}

function backward() {
  if (reader.prev()) return;
  if (current.bookId) moveChapter(-1);
  else toast('最初のページです', 1500);
}

// ---- 操作バー

const barsVisible = () => !$('topbar').hidden;

function showBars() {
  $('topbar').hidden = false;
  $('bottombar').hidden = false;
}

function hideBars() {
  $('topbar').hidden = true;
  $('bottombar').hidden = true;
}

function handleTap(x, y) {
  if (barsVisible()) return hideBars();
  const size = $('frame').getBoundingClientRect();
  const third = size.width / 3;
  if (settings.flow === 'page' && x < third) return settings.writing === 'vertical' ? forward() : backward();
  if (settings.flow === 'page' && x > third * 2) return settings.writing === 'vertical' ? backward() : forward();
  return showBars();
}

function setupGestures() {
  const frame = $('frame');
  let start = null;
  let pressTimer = 0;
  let longPressed = false; // 今の押下が長押しになったか
  let pointerType = 'mouse';

  const selection = () => window.getSelection();
  const selectingInText = () => {
    const sel = selection();
    return !sel.isCollapsed && $('content').contains(sel.anchorNode);
  };
  // タッチで文字を選択してよいのは長押しのときだけ（マウスのドラッグや PC のキー操作はそのまま）
  const selectionAllowed = () => pointerType === 'mouse' || longPressed;

  frame.addEventListener('selectstart', (e) => {
    if (!selectionAllowed() && selection().isCollapsed) e.preventDefault();
  });
  document.addEventListener('selectionchange', () => {
    if (!selectionAllowed() && selectingInText()) selection().removeAllRanges();
  });
  frame.addEventListener('mousedown', (e) => {
    // ページめくりのクリックが続いて、ダブルクリックの単語選択にならないようにする
    if (settings.flow === 'page' && e.detail > 1) e.preventDefault();
  });

  frame.addEventListener('pointerdown', (e) => {
    pointerType = e.pointerType;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp, hadSelection: selectingInText() };
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => (longPressed = true), SELECT_PRESS_MS);
  });
  frame.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) >= TAP_MOVE_LIMIT) clearTimeout(pressTimer);
  });
  frame.addEventListener('pointercancel', () => {
    clearTimeout(pressTimer);
    start = null;
  });
  frame.addEventListener('pointerup', (e) => {
    clearTimeout(pressTimer);
    if (!start) return;
    const { hadSelection } = start;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const longPress = e.timeStamp - start.t > LONG_PRESS_MS;
    start = null;
    if (longPress) return;
    if (Math.abs(dx) < TAP_MOVE_LIMIT && Math.abs(dy) < TAP_MOVE_LIMIT) {
      // 選択中のタップは選択の解除だけにする
      if (hadSelection) selection().removeAllRanges();
      else handleTap(e.clientX, e.clientY);
      return;
    }
    // マウスのドラッグは文字の選択
    if (settings.flow !== 'page' || hadSelection || barsVisible() || selectingInText()) return;
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy)) {
      // 縦書きは右へ払うと次へ、横書きは左へ払うと次へ
      const toNext = settings.writing === 'vertical' ? dx > 0 : dx < 0;
      if (toNext) forward();
      else backward();
    }
  });

  let wheelAt = 0;
  frame.addEventListener(
    'wheel',
    (e) => {
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : -e.deltaX;
      if (settings.flow === 'page') {
        e.preventDefault();
        if (e.timeStamp - wheelAt < 150 || !delta) return;
        wheelAt = e.timeStamp;
        if (delta > 0) forward();
        else backward();
      } else if (settings.writing === 'vertical') {
        e.preventDefault();
        reader.scrollBlock += delta;
      }
    },
    { passive: false },
  );

  $('scroller').addEventListener('scroll', () => {
    if (settings.flow === 'scroll' && current) {
      reader.held = null;
      reader.notify();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!current || $('settings-dialog').open || $('toc-dialog').open) return;
    const vertical = settings.writing === 'vertical';
    const nextKeys = [vertical ? 'ArrowLeft' : 'ArrowRight', 'ArrowDown', 'PageDown', ' '];
    const prevKeys = [vertical ? 'ArrowRight' : 'ArrowLeft', 'ArrowUp', 'PageUp'];
    if (nextKeys.includes(e.key)) {
      e.preventDefault();
      forward();
    } else if (prevKeys.includes(e.key)) {
      e.preventDefault();
      backward();
    }
  });
}

// ---- 目次

function tocButton(label, sub, isCurrent, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'toc-item';
  b.textContent = label;
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    b.append(s);
  }
  if (isCurrent) b.setAttribute('aria-current', 'true');
  b.addEventListener('click', onClick);
  return b;
}

async function openToc() {
  const chapters = $('toc-chapters');
  const headings = $('toc-headings');
  chapters.textContent = '';
  headings.textContent = '';
  const dialog = $('toc-dialog');
  for (const d of await bookDocs()) {
    chapters.append(
      tocButton(displayName(d.name), `${progressLabel(d.progress)} ・ 受信 ${formatDate(d.receivedAt)}`, d.id === current.id, () => {
        dialog.close();
        openDoc(d.id);
      }),
    );
  }
  reader.lines.forEach((line, i) => {
    if (HEADING.test(line)) {
      headings.append(
        tocButton(line.trim(), '', false, () => {
          dialog.close();
          reader.goToLine(i);
        }),
      );
    }
  });
  if (!chapters.children.length && !headings.children.length) {
    const none = document.createElement('p');
    none.textContent = '見出しはありません。下のスライダーで移動できます。';
    headings.append(none);
  }
  dialog.showModal();
}

// ---- 設定

function syncSettingsForm() {
  const form = $('settings-form');
  for (const el of form.elements) {
    if (el.name && el.name !== 'bracket') el.value = settings[el.name];
  }
  for (const out of form.querySelectorAll('output[data-for]')) {
    const key = out.dataset.for;
    if (key === 'botenSize') out.textContent = `${Math.round(settings[key] * 100)}%`;
    else out.textContent = key === 'fontSize' || key === 'margin' ? `${settings[key]}px` : Number(settings[key]).toFixed(1);
  }
  $('custom-colors').hidden = settings.theme !== 'custom';
  const inReader = Boolean(current);
  $('bracket-row').hidden = !inReader;
  if (inReader) {
    const override = (currentBook ? currentBook.bracket : current.bracket) ?? 'auto';
    form.elements.bracket.value = override;
    const autoOption = form.elements.bracket.querySelector('option[value="auto"]');
    const label = current.detected === '｛' ? '｛｝' : current.detected === '《' ? '《》' : 'なし';
    autoOption.textContent = override === 'auto' ? `自動（判定: ${label}）` : '自動';
  }
}

async function onBracketChange(value) {
  if (currentBook) {
    currentBook.bracket = value;
    await store.putBook(currentBook);
  } else {
    current.bracket = value;
  }
  const pos = reader.capture();
  await renderCurrent();
  reader.restore(pos);
  syncSettingsForm();
}

function setupSettings() {
  const form = $('settings-form');
  form.addEventListener('input', (e) => {
    const { name, value, type } = e.target;
    if (!name) return;
    if (name === 'bracket') {
      onBracketChange(value);
      return;
    }
    // 組み直す前に、今見ている文字を覚えておく
    if (current) reader.held = reader.capture();
    settings[name] = type === 'range' ? Number(value) : value;
    saveSettings(settings);
    applyTheme(settings);
    relayout();
    syncSettingsForm();
  });
  const open = () => {
    syncSettingsForm();
    $('settings-dialog').showModal();
  };
  $('open-settings').addEventListener('click', open);
  $('library-settings').addEventListener('click', open);
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
}

// ---- 起動

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 新しい版に入れ替わったら読み込み直す（位置は保存されている）
    if (hadController) savePositionNow().finally(() => location.reload());
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.version) $('version').textContent = `版: ${e.data.version}`;
  });
  navigator.serviceWorker.register('sw.js', { type: 'module' }).then((reg) => {
    (reg.active ?? reg.installing ?? reg.waiting)?.postMessage('version');
  });
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage('version'));
}

function setupDrop() {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) openPicked(e.dataTransfer.files);
  });
}

async function main() {
  applyTheme(settings);
  setupServiceWorker();
  setupGestures();
  setupSettings();
  setupDrop();

  $('file-input').addEventListener('change', async (e) => {
    await openPicked(e.target.files);
    e.target.value = '';
  });
  $('dropbox-toggle').addEventListener('click', toggleDropbox);
  $('back').addEventListener('click', () => history.back());
  $('open-toc').addEventListener('click', openToc);
  $('next-chapter').addEventListener('click', () => moveChapter(1));
  $('prev-chapter').addEventListener('click', () => moveChapter(-1));
  $('slider').addEventListener('input', (e) => reader.goToFraction(Number(e.target.value) / 1000));

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 120);
  }).observe($('frame'));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePositionNow();
    else updateDropboxRow(); // 認証の戻りが Chrome のタブに開いたときは、アプリへ戻ったここで反映する
  });
  window.addEventListener('pagehide', () => savePositionNow());
  window.addEventListener('popstate', () => {
    if (history.state?.view === 'reader') {
      const last = storageGet(LAST_DOC_KEY);
      if (last) openDoc(last, { pushHistory: false });
    } else {
      showLibrary();
    }
  });

  // 一覧の上に本文を積む形にして、戻るボタンで一覧へ戻れるようにする
  const params = new URLSearchParams(location.search);
  history.replaceState({ view: 'library' }, '', location.pathname);
  const fromDropbox = params.has('code') || params.has('error');
  await finishDropboxAuth(params);

  let target = null;
  try {
    target = await processInbox();
  } catch (e) {
    console.error(e);
    toast('受け取ったファイルを読めませんでした');
  }
  const last = storageGet(LAST_DOC_KEY);
  if (target) await openDoc(target);
  else if (last && !params.has('shared') && !fromDropbox && (await store.getDoc(last))) await openDoc(last);
  else await showLibrary();
}

main();
