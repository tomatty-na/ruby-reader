// Dropbox との接続（PKCE）と API の呼び出し。サーバを介さず、ブラウザから Dropbox へ直接つなぐ

// App key は公開してよい値（PKCE では App secret を使わない）。空のあいだは接続の操作を出さない
const APP_KEY = '1qq22hn8p6n8io5';

const AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API_URL = 'https://api.dropboxapi.com/2/';
const CONTENT_URL = 'https://content.dropboxapi.com/2/';
const SCOPES = 'files.metadata.read files.content.read';
const TOKENS_KEY = 'ruby-reader-dropbox-tokens';
const PENDING_KEY = 'ruby-reader-dropbox-pending';
const EXPIRY_MARGIN_MS = 60_000; // 期限の直前に切れないよう、早めに取り直す

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// HTTP ヘッダーには ASCII しか入れられないので、それ以外は \uXXXX にする
const headerJson = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// content_hash は内容が同じなら変わらないが、返らないこともある
export const versionOf = (entry) => entry.content_hash ?? entry.rev;
export const isTextFile = (entry) => entry['.tag'] === 'file' && /\.txt$/i.test(entry.name);
export const linkOf = (entry) => ({ id: entry.id, path: entry.path_display, version: versionOf(entry) });

const isStale = (doc, entry) => doc.dropbox.version !== versionOf(entry) || doc.name !== entry.name;

// 取得し直すファイルを探す（本文は取得しない）。Dropbox で消えたものは端末に残す
// 戻り値: { entry, docId }（既存の更新）または { entry, bookId }（束のフォルダに増えたファイル）の配列
export async function findChanges(client, docs, books) {
  const changes = [];
  const skipGone = (e) => {
    if (e.status !== 409) throw e;
    return null;
  };
  const folderBooks = books.filter((b) => b.dropbox && docs.some((d) => d.bookId === b.id));
  for (const book of folderBooks) {
    const entries = await client.listFolder(book.dropbox.ref).catch(skipGone);
    const members = docs.filter((d) => d.bookId === book.id);
    for (const entry of (entries ?? []).filter(isTextFile)) {
      const doc = members.find((d) => d.dropbox?.id === entry.id);
      if (!doc) changes.push({ entry, bookId: book.id });
      else if (isStale(doc, entry)) changes.push({ entry, docId: doc.id });
    }
  }
  const inFolderBook = new Set(folderBooks.map((b) => b.id));
  for (const doc of docs.filter((d) => d.dropbox && !inFolderBook.has(d.bookId))) {
    const entry = await client.getMetadata(doc.dropbox.id).catch(skipGone);
    if (entry && isStale(doc, entry)) changes.push({ entry, docId: doc.id });
  }
  return changes;
}

export class DropboxClient {
  // storage: get(key) と set(key, value)（value が null なら消す）を持つもの
  constructor({ storage, appKey = APP_KEY, fetchFn = (...args) => fetch(...args), now = () => Date.now() }) {
    this.storage = storage;
    this.appKey = appKey;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  get configured() {
    return Boolean(this.appKey);
  }

  get connected() {
    return Boolean(this.storage.get(TOKENS_KEY));
  }

  // 認証の画面の URL を作る。戻ってきたときに照合する値を保存しておく
  async authorizeUrl(redirectUri) {
    const verifier = randomString();
    const state = randomString();
    this.storage.set(PENDING_KEY, JSON.stringify({ verifier, state, redirectUri }));
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.appKey,
      response_type: 'code',
      code_challenge: await codeChallenge(verifier),
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
      state,
      token_access_type: 'offline', // refresh token を受け取る（D-18）
      scope: SCOPES,
    });
    return url.href;
  }

  // 認証の画面から戻ってきたときの処理。戻りでなければ false、接続できたら true
  async handleRedirect(params) {
    const code = params.get('code');
    const error = params.get('error');
    if (!code && !error) return false;
    const pending = JSON.parse(this.storage.get(PENDING_KEY) ?? 'null');
    this.storage.set(PENDING_KEY, null);
    if (!pending || params.get('state') !== pending.state) throw new Error('認証の情報が合いません。もう一度接続してください');
    if (error) throw new Error(error === 'access_denied' ? 'Dropboxとの接続を取りやめました' : `Dropboxの認証に失敗しました（${error}）`);
    const res = await this.request(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.verifier,
        client_id: this.appKey,
        redirect_uri: pending.redirectUri,
      }),
    });
    if (!res.ok) throw await this.failure(res);
    this.saveTokens(await res.json());
    return true;
  }

  // 接続を切る。Dropbox 側の取り消しに失敗しても、端末からは消す
  async disconnect() {
    const tokens = this.tokens();
    this.storage.set(TOKENS_KEY, null);
    if (!tokens) return;
    await this.request(`${API_URL}auth/token/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    }).catch(() => {});
  }

  // フォルダの中身をすべて返す（ルートは ''）
  async listFolder(path) {
    let page = await this.rpc('files/list_folder', { path });
    const entries = [...page.entries];
    while (page.has_more) {
      page = await this.rpc('files/list_folder/continue', { cursor: page.cursor });
      entries.push(...page.entries);
    }
    return entries;
  }

  getMetadata(ref) {
    return this.rpc('files/get_metadata', { path: ref });
  }

  // ref はパスまたは ID。メタデータは本文と同じ版のものが返る
  async download(ref) {
    const res = await this.authorized((token) =>
      this.request(`${CONTENT_URL}files/download`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': headerJson({ path: ref }) },
      }),
    );
    return { blob: await res.blob(), metadata: JSON.parse(res.headers.get('Dropbox-API-Result')) };
  }

  async rpc(endpoint, args) {
    const res = await this.authorized((token) =>
      this.request(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      }),
    );
    return res.json();
  }

  async authorized(send) {
    let res = await send(await this.accessToken());
    if (res.status === 401) res = await send(await this.refresh()); // 期限内でも取り消されていることがある
    if (!res.ok) throw await this.failure(res);
    return res;
  }

  tokens() {
    return JSON.parse(this.storage.get(TOKENS_KEY) ?? 'null');
  }

  saveTokens({ access_token, expires_in, refresh_token }) {
    this.storage.set(
      TOKENS_KEY,
      JSON.stringify({
        accessToken: access_token,
        expiresAt: this.now() + expires_in * 1000,
        refreshToken: refresh_token ?? this.tokens()?.refreshToken, // 取り直しの応答には refresh token が入らない
      }),
    );
  }

  async accessToken() {
    const tokens = this.tokens();
    if (!tokens) throw new Error('Dropboxに接続していません');
    return tokens.expiresAt - EXPIRY_MARGIN_MS > this.now() ? tokens.accessToken : this.refresh();
  }

  async refresh() {
    const tokens = this.tokens();
    if (!tokens) throw new Error('Dropboxに接続していません');
    const res = await this.request(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: this.appKey }),
    });
    if (res.status === 400 || res.status === 401) {
      // Dropbox 側で取り消された。通信の失敗では接続を消さない
      this.storage.set(TOKENS_KEY, null);
      throw new Error('Dropboxとの接続が切れました。接続し直してください');
    }
    if (!res.ok) throw await this.failure(res);
    this.saveTokens(await res.json());
    return this.tokens().accessToken;
  }

  async request(url, options) {
    try {
      return await this.fetchFn(url, options);
    } catch {
      throw new Error('Dropboxにつながりません。通信の状態を確かめてください');
    }
  }

  async failure(res) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return Object.assign(new Error(`Dropboxの呼び出しに失敗しました（${res.status}: ${detail}）`), { status: res.status });
  }
}
