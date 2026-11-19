# PhysiProof-hiroki の Google ログイン

ログイン画面の「Googleで続ける」は、連携済みなら従来と同じユーザーでログインします。初回は「新しく登録する」または「既存アカウントに連携」を選択します。プロフィールの「Googleアカウントを連携」からも開始できます。既存アカウントへの初回連携には現在のログインIDとパスワードが必要です。

## ローカル起動

1. Google Cloud の Google Auth Platform で表示名、対象ユーザー、必要ならテストユーザーを設定し、hiroki 用に「ウェブ アプリケーション」のOAuthクライアントを作成します。
2. 承認済みのリダイレクトURIに `http://127.0.0.1:5173/auth/google/callback` を完全一致で登録します。コールバックを受けるのはReactの画面です。
3. `packages/backend/.dev.vars` に下記の値を設定します。このファイルはGit管理外です。シークレットはWorkerにだけ渡します。

```dotenv
GOOGLE_CLIENT_ID=<hiroki用WebクライアントのID>
GOOGLE_CLIENT_SECRET=<同じクライアントのシークレット>
GOOGLE_REDIRECT_URI=http://127.0.0.1:5173/auth/google/callback
```

4. リポジトリのルートで `npm ci`、続いて `npm run dev` を実行します。起動時にローカルD1にマイグレーションが適用されます。ブラウザで `http://127.0.0.1:5173/login` を開きます。

## 公開環境

hiroki 専用の Worker、D1、フロントエンドを使用し、Worker の DB バインディングを確認してから 0045 まで適用します。元プロジェクトの本番リソースを参照する既存デプロイジョブはフォークではスキップされます。

Googleに公開環境の正確なHTTPSコールバック（フロントの `/auth/google/callback`）を登録し、同じURLを `GOOGLE_REDIRECT_URI` に設定します。フロントエンドはそのパスをSPAに配信してください。Workerに `GOOGLE_CLIENT_ID` とSecretの `GOOGLE_CLIENT_SECRET` を設定します。ログインに要求するスコープは `openid` です。

Web画面と `/api` を同一HTTPSオリジンで配信する場合、Workerに `GOOGLE_WEB_COOKIE=true` を設定してください。Googleログイン後は14日間のHttpOnly・Secure・SameSite=Lax Cookieを使い、書き込みにはフロントのOriginとの一致を要求します。WebとAPIを別オリジンに置く場合や既存のネイティブ走行ブリッジにBearerが必要な環境では、この設定を省略し、フロントの `VITE_API_URL` をhirokiのWorkerに向けます。今回のGoogle認証画面はWebブラウザ向けです。

## アカウントと認証処理

- D1の `auth_identities` がGoogleの発行元・subjectを既存の `users.id` に結び付けます。各ユーザーはGoogleアカウントを1つ連携できます。メールアドレスによる自動連携は行いません。
- 既存のログインIDとパスワードハッシュを移行時に保持します。Google新規登録では内部ログインIDを採番し、パスワード欄をNULLにします。既存のプロフィール設定でログインIDやパスワードを設定できます。
- WorkerがPKCE・nonceを生成し、認可コードを交換してGoogleの公開鍵でIDトークンを検証します。認証を開始したタブが持つ秘密値とstateを照合し、認証要求と登録・連携のチケットは各10分・1回限りです。認証完了後は既存のアプリセッションを発行します。
- 署名済みのテスト用IDトークンとインメモリSQLiteを使う統合テストは Node 24 以降で `npx vitest run packages/backend/src/googleAuth.integration.test.ts` から実行できます。
