// 読んでいた位置の記録と復元。改稿で行がずれても戻れるように、位置の直後の本文も一緒に覚える

const ANCHOR_LENGTH = 32;
const SEARCH_LENGTHS = [32, 16, 8];

export function makePosition(lines, line, offset) {
  let anchor = (lines[line] ?? '').slice(offset);
  for (let l = line + 1; l < lines.length && anchor.length < ANCHOR_LENGTH; l++) anchor += '\n' + lines[l];
  return { line, offset, anchor: anchor.slice(0, ANCHOR_LENGTH), lineCount: lines.length };
}

function nearestIndex(full, needle, expected) {
  let best = -1;
  for (let i = full.indexOf(needle); i >= 0; i = full.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - expected) < Math.abs(best - expected)) best = i;
  }
  return best;
}

export function resolvePosition(lines, pos) {
  if (!pos) return { line: 0, offset: 0 };
  const anchor = pos.anchor ?? '';
  const full = lines.join('\n');
  // 行の開始位置（lineStarts[lines.length] は末尾）
  const lineStarts = [0];
  for (const l of lines) lineStarts.push(lineStarts[lineStarts.length - 1] + l.length + 1);
  const clampedLine = Math.min(pos.line, lines.length - 1);
  const expected = lineStarts[clampedLine] + Math.min(pos.offset, lines[clampedLine].length);

  if (anchor.trim() && full.startsWith(anchor, expected)) return { line: clampedLine, offset: expected - lineStarts[clampedLine] };
  if (anchor.trim()) {
    for (const len of SEARCH_LENGTHS) {
      const needle = anchor.slice(0, len);
      if (needle.length < Math.min(len, 8) || !needle.trim()) continue;
      const i = nearestIndex(full, needle, expected);
      if (i >= 0) {
        let line = lineStarts.findIndex((s) => s > i) - 1;
        if (line < 0) line = lines.length - 1;
        return { line, offset: i - lineStarts[line] };
      }
    }
  }
  // 見つからなければ、行数の比で近いところへ
  const ratio = pos.lineCount ? pos.line / pos.lineCount : 0;
  return { line: Math.min(Math.round(ratio * lines.length), lines.length - 1), offset: 0 };
}
