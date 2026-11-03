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
  // Dropbox の ID が分かれば、それだけで判断する。どちらにも ID があって違うなら別のファイル
  const linked = file.dropbox && docs.find((d) => d.dropbox?.id === file.dropbox.id);
  if (linked) return linked;
  return docs
    .filter((d) => d.name === file.name && !(file.dropbox && d.dropbox) && similarity(d.text, file.text) >= SAME_FILE_SIMILARITY)
    .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))[0];
}

const updateOf = (match, file, bookId) => ({ id: match.id, name: file.name, text: file.text, bookId, dropbox: file.dropbox ?? match.dropbox ?? null });
const createOf = (id, file, bookId) => ({ id, name: file.name, text: file.text, bookId, dropbox: file.dropbox ?? null });

// 戻り値: updates（既存の更新）、creates（新規）、newBook（新しい束）、bookId（入れた束）、openId（開くファイル）、changed（内容が変わった数）
export function planIncoming(files, docs, books, newId, { title } = {}) {
  const sorted = [...files].sort((a, b) => compareNames(a.name, b.name));
  const updates = [];
  const creates = [];
  let newBook = null;
  let bookId = null;
  let openId;

  if (sorted.length === 1) {
    const [file] = sorted;
    const match = findMatch(file, docs);
    if (match) {
      bookId = match.bookId ?? null;
      updates.push(updateOf(match, file, bookId));
      openId = match.id;
    } else {
      openId = newId();
      creates.push(createOf(openId, file, null));
    }
  } else {
    // 一緒に届いたファイルは1つの束にする。既存の束と重なるならそこへ入れる
    const votes = new Map();
    for (const file of sorted) {
      const match = findMatch(file, docs);
      if (match?.bookId) votes.set(match.bookId, (votes.get(match.bookId) ?? 0) + 1);
    }
    bookId = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!bookId) {
      bookId = newId();
      newBook = { id: bookId, title: title ?? `${sorted[0].name} ほか${sorted.length - 1}件` };
    }
    const reachable = docs.filter((d) => !d.bookId || d.bookId === bookId);
    const ids = [];
    for (const file of sorted) {
      const match = findMatch(file, reachable);
      if (match) {
        updates.push(updateOf(match, file, bookId));
        ids.push(match.id);
      } else {
        const id = newId();
        creates.push(createOf(id, file, bookId));
        ids.push(id);
      }
    }
    const lastDocId = books.find((b) => b.id === bookId)?.lastDocId;
    openId = ids.includes(lastDocId) ? lastDocId : ids[0];
  }

  const changed = updates.filter((u) => docs.find((d) => d.id === u.id).text !== u.text).length;
  return { updates, creates, newBook, bookId, openId, changed };
}
