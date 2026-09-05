/**
 * Claude Artifacts の `window.storage` API を、通常のブラウザで動かすための
 * localStorage ベースの簡易実装。
 *
 * 注意: Claude Artifacts 上での "shared"（全員が同じデータを見る）という挙動は、
 * このスタンドアロン版では再現できません（localStorage はブラウザ単位のため）。
 * 複数人で同じデータを共有したい場合は、本物のバックエンド（DB + API）に
 * 置き換えてください。get/set/delete/list の呼び出し口はそのまま使えます。
 */
const NS = 'inventory-kpi-app';

function fullKey(key, shared) {
  return `${NS}:${shared ? 'shared' : 'personal'}:${key}`;
}

function install() {
  if (typeof window === 'undefined') return;
  if (window.storage) return; // 本物の環境（Claude Artifacts）では上書きしない

  window.storage = {
    async get(key, shared = false) {
      const raw = window.localStorage.getItem(fullKey(key, shared));
      if (raw === null) {
        throw new Error(`storage: key not found: ${key}`);
      }
      return { key, value: raw, shared };
    },

    async set(key, value, shared = false) {
      window.localStorage.setItem(fullKey(key, shared), value);
      return { key, value, shared };
    },

    async delete(key, shared = false) {
      window.localStorage.removeItem(fullKey(key, shared));
      return { key, deleted: true, shared };
    },

    async list(prefix = '', shared = false) {
      const marker = `${NS}:${shared ? 'shared' : 'personal'}:`;
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(marker + prefix)) keys.push(k.slice(marker.length));
      }
      return { keys, prefix, shared };
    },
  };
}

install();
