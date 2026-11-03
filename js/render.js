// 解釈した行を HTML にする

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);

// 縦書きで1文字分に収める並び（半角数字1〜2桁、感嘆符・疑問符の2連）
const TCY = /(?<![0-9A-Za-z.])[0-9]{1,2}(?![0-9A-Za-z.])|(?<![！？!?])[！？!?]{2}(?![！？!?])/g;

function textHtml(text) {
  let html = '';
  let last = 0;
  for (const m of text.matchAll(TCY)) {
    html += escapeHtml(text.slice(last, m.index)) + `<span class="tcy">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

export function lineHtml(segs) {
  return segs
    .map((s) => {
      if (s.type === 'ruby') return `<ruby>${escapeHtml(s.base)}<rt>${escapeHtml(s.ruby)}</rt></ruby>`;
      if (s.type === 'boten') return `<span class="boten">${escapeHtml(s.base)}</span>`;
      return textHtml(s.text);
    })
    .join('');
}

export function paragraphHtml(segs) {
  return segs.length ? `<p>${lineHtml(segs)}</p>` : '<p><br></p>';
}
