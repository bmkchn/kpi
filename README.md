# 在庫・KPI管理

Claude Artifacts で作成したアプリを、通常の Vite + React プロジェクトとして
書き出したものです。ローカルで動かすことも、Git で管理することもできます。

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで `http://localhost:5173` を開くと動作します。

## データの保存について

このアプリは `window.storage` という保存機能を使っています。
Supabase の環境変数を設定すると共有データを Supabase に保存し、未設定の場合は
ブラウザの `localStorage` を使います。

### Supabase の設定

1. Supabase でプロジェクトを作成します。
2. SQL Editor で `supabase/schema.sql` を実行します。
3. `.env.example` を `.env.local` にコピーし、Supabase の URL と anon key を設定します。
4. GitHub Pages で Supabase を使う場合は、リポジトリの Settings > Secrets and variables > Actions に
  `SUPABASE_URL` と `SUPABASE_ANON_KEY` を登録します。

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

`.env.local` は Git にコミットしないでください。Supabase の anon key はブラウザへ公開される前提のキーですが、
データの保護は SQL の RLS ポリシーで行います。現在のスキーマは匿名ユーザーが共有データを読み書きできる設定です。
利用者ごとの権限管理が必要になった場合は、Supabase Auth とユーザー単位の RLS に切り替えてください。

## Git で管理する

```bash
git init
git add .
git commit -m "Initial commit: 在庫・KPI管理アプリ"
```

GitHub などのリモートに繋ぐ場合:

```bash
git remote add origin <あなたのリポジトリURL>
git branch -M main
git push -u origin main
```

## ビルド（本番用ファイルの作成）

```bash
npm run build
```

`dist/` フォルダに静的ファイルが出力されます。Vercel・Netlify・GitHub Pages など、
静的ホスティングにそのままデプロイできます。

## ファイル構成

```
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── supabase/
│   └── schema.sql        # Supabase のテーブルと RLS ポリシー
└── src/
    ├── main.jsx        # エントリーポイント
    ├── App.jsx         # アプリ本体（元のArtifactの中身）
  ├── storageShim.js  # Supabase / localStorage の保存層
    └── index.css       # Tailwindの読み込み
```
