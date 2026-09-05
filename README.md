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

このアプリは元々 Claude Artifacts の `window.storage` という保存機能を使っています。
`src/storageShim.js` が、それをブラウザの `localStorage` で代用する簡易実装です。

- Claude Artifacts 上での「SHARED（全員が同じデータを見る）」という挙動は、
  このスタンドアロン版では再現されません（localStorage はブラウザ単位のため）。
- 複数人・複数端末でデータを共有したい場合は、`storageShim.js` の
  `get` / `set` / `delete` / `list` を、実際のバックエンド（DB + API）を呼ぶ
  実装に差し替えてください。呼び出し側（`src/App.jsx`）は変更不要です。

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
└── src/
    ├── main.jsx        # エントリーポイント
    ├── App.jsx         # アプリ本体（元のArtifactの中身）
    ├── storageShim.js  # window.storage の localStorage 代替実装
    └── index.css       # Tailwindの読み込み
```
