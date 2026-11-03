// ファイルの文字コードを見分けて文字列にする（UTF-8 を優先し、だめなら UTF-16 の BOM、Shift_JIS の順）

export class NotTextError extends Error {}

export function decodeBytes(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
      } catch {
        throw new NotTextError('テキストファイルとして読めませんでした');
      }
    }
  }
  if (text.includes('\0')) throw new NotTextError('テキストファイルとして読めませんでした');
  return text;
}
