import './GoogleAuth.css';
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../lib/hc';

const transactionKey = 'hiroki_google_transaction';
type Pending = { ticket: string; linkOnly: boolean };
type Profile = { userId: string; name: string; role: string };
type SignedIn = { profile: Profile; accessToken: string | null; uniformAdminToken?: string };

async function post<T>(path: string, body: unknown, authenticated = false): Promise<T> {
  const bearer = authenticated && localStorage.getItem('physiproof_access_token');
  const res = await fetch(API_BASE_URL + '/api/auth/google/' + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer && !bearer.startsWith('cookie:') ? { Authorization: 'Bearer ' + bearer } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(
      typeof data.error === 'string' ? data.error : '入力を確認し、もう一度やり直してください。',
    );
  return data as T;
}

export function GoogleButton({ link = false }: { link?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    setBusy(true);
    setError('');
    try {
      const { url, state, browserKey } = await post<{ url: string; state: string; browserKey: string }>(
        link ? 'link/start' : 'start',
        {},
        link,
      );
      sessionStorage.setItem(transactionKey, JSON.stringify({ state, browserKey }));
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : '認証を開始できませんでした。');
      setBusy(false);
    }
  }
  return (
    <div className="google-action">
      <button type="button" disabled={busy} onClick={start}>
        {link ? 'Googleアカウントを連携' : 'Googleで続ける'}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function GoogleCallback() {
  const navigate = useNavigate();
  const started = useRef(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [action, setAction] = useState<'register' | 'link' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function enter(result: SignedIn) {
    localStorage.setItem('physiproof_user', JSON.stringify(result.profile));
    localStorage.setItem('physiproof_test_uid', result.profile.userId);
    localStorage.setItem('physiproof_access_token', result.accessToken ?? 'cookie:' + crypto.randomUUID());
    localStorage.removeItem('physiproof_uniform_admin_token');
    if (result.uniformAdminToken)
      localStorage.setItem('physiproof_uniform_admin_token', result.uniformAdminToken);
    window.dispatchEvent(new Event('physiproof-session-restored'));
    navigate(result.profile.role === 'admin' ? '/admin' : '/dashboard', { replace: true });
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(location.search);
    history.replaceState(null, '', location.pathname);
    const stored = sessionStorage.getItem(transactionKey);
    sessionStorage.removeItem(transactionKey);
    async function exchange() {
      if (query.get('error')) throw new Error('Googleでのログインがキャンセルされました。');
      const flow = stored && JSON.parse(stored);
      const code = query.get('code');
      if (!code || !flow || flow.state !== query.get('state'))
        throw new Error('Googleログインを最初からやり直してください。');
      const result = await post<Pending | SignedIn>('exchange', { ...flow, code });
      if ('profile' in result) enter(result);
      else {
        setPending(result);
        if (result.linkOnly) setAction('link');
      }
    }
    exchange().catch((e) => setError(e.message));
  }, []);
  async function finish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending || !action || busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const details =
        action === 'register'
          ? { name: fields.get('name'), age: Number(fields.get('age')) }
          : { loginId: fields.get('loginId'), password: fields.get('password') };
      enter(await post<SignedIn>('finish', { ...details, action, ticket: pending.ticket }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインを完了できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="google-callback cyber-glass">
      <h1>
        {action === 'register' ? '新規登録' : action === 'link' ? '既存アカウントに連携' : 'Googleでログイン'}
      </h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <a href="/login">ログイン画面へ戻る</a>
        </>
      ) : !pending ? (
        <p role="status">Googleの認証結果を確認しています…</p>
      ) : !action ? (
        <>
          <p>これまでの走行記録やチームがある方は、既存アカウントに連携してください。</p>
          <button onClick={() => setAction('link')}>既存アカウントに連携</button>
          <button onClick={() => setAction('register')}>新しく登録する</button>
        </>
      ) : (
        <form onSubmit={finish}>
          {action === 'link' ? (
            <>
              <label>
                現在のログインID
                <input name="loginId" autoComplete="username" required maxLength={256} />
              </label>
              <label>
                現在のパスワード
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={4096}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                表示名
                <input name="name" autoComplete="nickname" required maxLength={100} />
              </label>
              <label>
                年齢
                <input name="age" type="number" min={1} max={120} required />
              </label>
            </>
          )}
          <button disabled={busy}>{action === 'link' ? '確認してGoogleと連携する' : '登録して始める'}</button>
          {!pending.linkOnly && (
            <button type="button" disabled={busy} onClick={() => setAction(null)}>
              選び直す
            </button>
          )}
        </form>
      )}
    </main>
  );
}
