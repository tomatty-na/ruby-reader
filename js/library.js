// 受け取ったファイルを、保存済みのファイルにどう反映するかを決める（保存はしない）

const collator = new Intl.Collator('ja', { numeric: true });
export const compareNames = (a, b) => collator.compare(a, b);

// 同じファイルの改稿とみなす、共通する行の割合の下限。
// Dropbox からはファイル名しか届かないので、別の作品の同名のファイルを上書きしないために見る
const SAME_FILE_SIMILARITY = 0.2;

function lineSet(text) {
  return new Set(text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean));
}

export function similarity(a, b) {
  const sa = lineSet(a);
  const sb = lineSet(b);
  if (!sa.size || !sb.size) return 1;
  let common = 0;
  for (const l of sa) if (sb.has(l)) common++;
  return common / Math.min(sa.size, sb.size);
}

function findMatch(file, docs) {
  return docs
    .filter((d) => d.name === file.name && similarity(d.text, file.text) >= SAME_FILE_SIMILARITY)
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0];
}

// 戻り値: updates（既存の更新）、creates（新規）、newBook（新しい束）、openId（開くファイル）、changed（内容が変わった数）
export function planIncoming(files, docs, books, newId) {
  const sorted = [...files].sort((a, b) => compareNames(a.name, b.name));
  const updates = [];
  const creates = [];
  let newBook = null;
  let openId;

  if (sorted.length === 1) {
    const [file] = sorted;
    const match = findMatch(file, docs);
    if (match) {
      updates.push({ id: match.id, text: file.text, bookId: match.bookId ?? null });
      openId = match.id;
    } else {
      openId = newId();
      creates.push({ id: openId, name: file.name, text: file.text, bookId: null });
    }
  } else {
    // 一緒に届いたファイルは1つの束にする。既存の束と重なるならそこへ入れる
    const votes = new Map();
    for (const file of sorted) {
      const match = findMatch(file, docs);
      if (match?.bookId) votes.set(match.bookId, (votes.get(match.bookId) ?? 0) + 1);
    }
    let bookId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!bookId) {
      bookId = newId();
      newBook = { id: bookId, title: `${sorted[0].name} ほか${sorted.length - 1}件` };
    }
    const reachable = docs.filter((d) => !d.bookId || d.bookId === bookId);
    const ids = [];
    for (const file of sorted) {
      const match = findMatch(file, reachable);
      if (match) {
        updates.push({ id: match.id, text: file.text, bookId });
        ids.push(match.id);
      } else {
        const id = newId();
        creates.push({ id, name: file.name, text: file.text, bookId });
        ids.push(id);
      }
    }
    const lastDocId = books.find((b) => b.id === bookId)?.lastDocId;
    openId = ids.includes(lastDocId) ? lastDocId : ids[0];
  }

  const changed = updates.filter((u) => docs.find((d) => d.id === u.id).text !== u.text).length;
  return { updates, creates, newBook, openId, changed };
}
