// ルビ・傍点の解釈。規則は novel-correction/tools/preprocess.py の strip_ruby を元にしている。
// 違いは、解釈できない記法を外さずに本文のまま残すこと（改稿中の原稿の誤りが画面で見えるように）。

export const BRACKETS = { '《': '》', '｛': '｝' };
const BARS = new Set(['｜', '|']);
const KANJI = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{3FFFF}々〆〇ヶ]/u;
const LATIN = /[A-Za-zＡ-Ｚａ-ｚ]/;
const BOTEN = /^[、・﹅]+$/;

// bracket はルビの開き括弧（《 か ｛）。null ならルビとして解釈しない
export function parseLine(line, bracket = '《') {
  if (!bracket) return line ? [{ type: 'text', text: line }] : [];
  const open = bracket;
  const close = BRACKETS[bracket];
  const chars = Array.from(line);
  const segs = [];
  let buf = []; // 直前のルビより後の文字。省略した親文字はここより前に伸びない
  let barAt = null; // buf の中で親文字の指定（｜）があった位置
  let barChar = '';

  const restoreBar = () => {
    if (barAt !== null) buf.splice(barAt, 0, barChar);
    barAt = null;
  };
  const flushText = (end = buf.length) => {
    if (end > 0) segs.push({ type: 'text', text: buf.slice(0, end).join('') });
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (BARS.has(c)) {
      restoreBar();
      barAt = buf.length;
      barChar = c;
      continue;
    }
    if (c !== open) {
      buf.push(c);
      continue;
    }
    // ｜《 は括弧そのものを表す書き方
    if (barAt === buf.length) {
      barAt = null;
      buf.push(c);
      continue;
    }
    const j = chars.indexOf(close, i + 1);
    let start = barAt;
    if (start === null) {
      start = buf.length;
      const pat = start > 0 && LATIN.test(buf[start - 1]) ? LATIN : KANJI;
      while (start > 0 && pat.test(buf[start - 1])) start--;
    }
    // 閉じていない括弧や親文字のない括弧は、ルビではなく本文の括弧（通信音声の《……》など）
    if (j < 0 || start === buf.length) {
      restoreBar();
      buf.push(c);
      continue;
    }
    const base = buf.slice(start).join('');
    const ruby = chars.slice(i + 1, j).join('');
    flushText(start);
    if (ruby === '') segs.push({ type: 'text', text: base });
    else if (BOTEN.test(ruby)) segs.push({ type: 'boten', base, explicit: barAt !== null });
    else segs.push({ type: 'ruby', base, ruby, explicit: barAt !== null });
    buf = [];
    barAt = null;
    i = j;
  }
  restoreBar();
  flushText();
  return segs;
}

export function plainOf(segs) {
  return segs.map((s) => (s.type === 'text' ? s.text : s.base)).join('');
}

export function splitLines(text) {
  return text.split(/\r\n|\r|\n/);
}

function scoreBracket(lines, bracket) {
  let score = 0;
  for (const line of lines) {
    if (!line.includes(bracket)) continue;
    for (const s of parseLine(line, bracket)) {
      if (s.type === 'boten') score++;
      // 長い文や句点を含むものは、漢字の直後に置かれた本文の括弧とみなして数えない
      else if (s.type === 'ruby' && (s.explicit || (s.ruby.length <= 20 && !/[。！？]/.test(s.ruby)))) score++;
    }
  }
  return score;
}

// 作品が使っているルビの括弧を見分ける。｛ のほうがルビらしく使われていれば ｛｝、そうでなければ 《》
export function detectBracket(text) {
  const lines = splitLines(text);
  return scoreBracket(lines, '｛') > scoreBracket(lines, '《') ? '｛' : '《';
}
