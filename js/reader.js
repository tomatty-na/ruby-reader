// 本文の表示、ページめくり、位置の計算。
// ページは「行の高さの整数倍」の幅で区切り、ページの端で行が切れないようにしている
import { paragraphHtml } from './render.js';
import { parseLine, plainOf, splitLines } from './ruby.js';
import { makePosition, resolvePosition } from './position.js';

const INLINE_MARGIN = 24; // 行の始まりと終わりの余白（下はページ番号の分だけ広く取る）
const INDICATOR_SPACE = 20;
const MAX_LINE_FIT = 12;
const RUBY_REACH = 1.12; // 行の中心からルビの外側までの距離（文字サイズに対する比）

export class Reader {
  constructor({ frame, scroller, content, onChange }) {
    this.frame = frame;
    this.scroller = scroller;
    this.content = content;
    this.onChange = onChange;
    this.lines = [];
    this.settings = null;
    this.pageSize = 1;
    this.pageCount = 1;
    this.page = 0;
    this.bleed = 0;
    this.held = null;
  }

  get vertical() {
    return this.settings.writing === 'vertical';
  }

  get paged() {
    return this.settings.flow === 'page';
  }

  setText(text, bracket) {
    const parsed = splitLines(text).map((l) => parseLine(l, bracket));
    this.lines = parsed.map(plainOf);
    this.held = null;
    this.content.innerHTML = parsed.map(paragraphHtml).join('');
    this.paragraphs = [...this.content.children];
  }

  // 大きさの計算。位置はこの前後で capture / restore する
  layout(settings) {
    this.settings = settings;
    const m = settings.margin;
    const W = this.frame.clientWidth;
    const H = this.frame.clientHeight;
    const style = this.scroller.style;
    const inlineSize = this.vertical ? H - INLINE_MARGIN * 2 - INDICATOR_SPACE : W - m * 2;
    // 行の折り返しが決まるように、行の長さを先に決めてから行間を測る
    if (this.vertical) {
      style.height = `${inlineSize}px`;
      style.width = `${W}px`;
    } else {
      style.width = `${inlineSize}px`;
      style.height = `${H}px`;
    }
    const linePx = this.fitLinePitch(Math.max(1, Math.round(settings.fontSize * settings.lineHeight)));
    this.linePx = linePx;

    const blockAvail = (this.vertical ? W : H) - m * 2;
    this.pageSize = this.paged ? Math.max(1, Math.floor(blockAvail / linePx)) * linePx : blockAvail;

    // ルビは行の外へ少しはみ出す。ページの先頭の行のルビが切れないように、はみ出す分だけ表示を前へ広げ、
    // 次のページの先頭の行のルビが見えないように、ページの終わりを同じだけ削る
    const gap = (linePx - settings.fontSize) / 2;
    const bleed = Math.ceil(Math.max(0, settings.fontSize * RUBY_REACH - linePx / 2));
    this.bleed = bleed;
    const clipEnd = bleed + Math.min(bleed, gap);

    const blockBox = this.pageSize + bleed * 2;
    if (this.vertical) {
      style.width = `${blockBox}px`;
      style.left = `${Math.round((W - this.pageSize) / 2) - bleed}px`;
      style.top = `${INLINE_MARGIN}px`;
      style.clipPath = this.paged ? `inset(0 0 0 ${clipEnd}px)` : '';
    } else {
      style.height = `${blockBox}px`;
      style.left = `${m}px`;
      style.top = `${Math.round((H - INDICATOR_SPACE - this.pageSize) / 2) - bleed}px`;
      style.clipPath = this.paged ? `inset(0 0 ${clipEnd}px 0)` : '';
    }
    this.scroller.dataset.pageSize = this.pageSize;
    this.scroller.dataset.bleed = bleed;

    // 最後のページも1ページ分の幅があるように埋める
    this.content.style.paddingBlockStart = `${bleed}px`;
    this.content.style.paddingBlockEnd = '0';
    const rect = this.content.getBoundingClientRect();
    const total = (this.vertical ? rect.width : rect.height) - bleed;
    this.pageCount = Math.max(1, Math.ceil((total - 0.5) / this.pageSize));
    this.content.style.paddingBlockEnd = `${this.paged ? this.pageCount * this.pageSize - total + bleed : bleed}px`;
  }

  // 行間が狭いとルビの行だけ広がり、ページの区切りがずれる。
  // 広がり方は端末の書体で変わるので、実際の本文を組んでみて、そろう行間まで広げる
  fitLinePitch(wanted) {
    const root = document.documentElement;
    let linePx = wanted;
    for (let tries = 0; tries < MAX_LINE_FIT; tries++, linePx++) {
      root.style.setProperty('--line-px', `${linePx}px`);
      if (this.linesAligned(linePx)) break;
    }
    return linePx;
  }

  linesAligned(linePx) {
    const ps = this.paragraphs;
    if (!ps?.length) return true;
    const edge = (r) => (this.vertical ? -r.right : r.top);
    const first = edge(ps[0].getBoundingClientRect());
    return ps.every((p) => {
      const d = edge(p.getBoundingClientRect()) - first;
      return Math.abs(Math.round(d / linePx) * linePx - d) <= 0.5;
    });
  }

  // ---- ブロック方向の座標（縦書きでは右から左へ増える）

  get scrollBlock() {
    return this.vertical ? -this.scroller.scrollLeft : this.scroller.scrollTop;
  }

  set scrollBlock(v) {
    if (this.vertical) this.scroller.scrollLeft = -v;
    else this.scroller.scrollTop = v;
  }

  // 表示の先頭（はみ出し分を除く）からの距離
  blockStart(rect) {
    const view = this.scroller.getBoundingClientRect();
    return (this.vertical ? view.right - rect.right : rect.top - view.top) - this.bleed;
  }

  blockEnd(rect) {
    const view = this.scroller.getBoundingClientRect();
    return (this.vertical ? view.right - rect.left : rect.bottom - view.top) - this.bleed;
  }

  get maxScroll() {
    const size = this.vertical ? this.scroller.scrollWidth - this.scroller.clientWidth : this.scroller.scrollHeight - this.scroller.clientHeight;
    return Math.max(0, size);
  }

  // ---- 文字の位置

  textNodes(p) {
    const nodes = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement.closest('rt')) nodes.push(n);
    }
    return nodes;
  }

  charRect(nodes, offset) {
    let rest = offset;
    for (const node of nodes) {
      if (rest < node.length) {
        const range = document.createRange();
        range.setStart(node, rest);
        range.setEnd(node, rest + 1);
        return range.getClientRects()[0] ?? range.getBoundingClientRect();
      }
      rest -= node.length;
    }
    return null;
  }

  // ビューの先頭にある文字を探す。
  // 設定の変更で組み直しただけのときは、ページの先頭が前へずれていかないよう、最初に見ていた文字を保つ
  capture() {
    if (this.held) return this.held;
    const ps = this.paragraphs;
    if (!ps?.length) return null;
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.blockEnd(ps[mid].getBoundingClientRect()) > 1) hi = mid;
      else lo = mid + 1;
    }
    const line = lo;
    const nodes = this.textNodes(ps[line]);
    const length = this.lines[line].length;
    let a = 0;
    let b = length;
    while (a < b) {
      const mid = (a + b) >> 1;
      const rect = this.charRect(nodes, mid);
      if (rect && this.blockStart(rect) >= -1) b = mid;
      else a = mid + 1;
    }
    return makePosition(this.lines, line, Math.min(a, Math.max(0, length - 1)));
  }

  restore(pos, { atEnd = false } = {}) {
    if (atEnd) {
      this.goToFraction(1);
      return;
    }
    const { line, offset } = resolvePosition(this.lines, pos);
    this.goToLine(line, offset);
    this.held = makePosition(this.lines, line, offset);
  }

  goToLine(line, offset = 0) {
    this.held = null;
    const p = this.paragraphs?.[line];
    if (!p) return;
    const rect = this.charRect(this.textNodes(p), offset) ?? p.getBoundingClientRect();
    const target = this.scrollBlock + this.blockStart(rect);
    if (this.paged) this.goToPage(Math.floor((target + 1) / this.pageSize));
    else {
      this.scrollBlock = Math.max(0, target - (this.linePx - this.settings.fontSize) / 2);
      this.notify();
    }
  }

  // ---- 移動

  goToPage(n) {
    this.page = Math.min(Math.max(0, n), this.pageCount - 1);
    this.scrollBlock = this.page * this.pageSize;
    this.notify();
  }

  // 戻り値: 動けたか（false ならこのファイルの端）
  next() {
    this.held = null;
    if (this.paged) {
      if (this.page >= this.pageCount - 1) return false;
      this.goToPage(this.page + 1);
      return true;
    }
    if (this.scrollBlock >= this.maxScroll - 1) return false;
    this.scrollBlock += this.pageSize - this.linePx;
    return true;
  }

  prev() {
    this.held = null;
    if (this.paged) {
      if (this.page <= 0) return false;
      this.goToPage(this.page - 1);
      return true;
    }
    if (this.scrollBlock <= 1) return false;
    this.scrollBlock -= this.pageSize - this.linePx;
    return true;
  }

  get fraction() {
    if (this.paged) return this.pageCount > 1 ? this.page / (this.pageCount - 1) : 0;
    return this.maxScroll ? this.scrollBlock / this.maxScroll : 0;
  }

  goToFraction(f) {
    this.held = null;
    if (this.paged) this.goToPage(Math.round(f * (this.pageCount - 1)));
    else {
      this.scrollBlock = f * this.maxScroll;
      this.notify();
    }
  }

  notify() {
    this.onChange?.();
  }
}
