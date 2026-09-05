import { createClient } from '@supabase/supabase-js';

/* Supabase 未設定のローカル開発では、従来どおり localStorage を使う。 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;
const NS = 'inventory-kpi-app';
const TABLE = 'app_storage';

function fullKey(key, shared) {
  return `${NS}:${shared ? 'shared' : 'personal'}:${key}`;
}

function localStorageApi() {
  return {
    async get(key, shared = false) {
      const raw = window.localStorage.getItem(fullKey(key, shared));
      if (raw === null) throw new Error(`storage: key not found: ${key}`);
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

function warnFallback(error) {
  console.warn('Supabase storage is unavailable; falling back to localStorage.', error);
}

function supabaseStorageApi(local) {
  return {
    async get(key, shared = false) {
      if (!shared) return local.get(key, false);
      const { data, error } = await supabase
        .from(TABLE)
        .select('key, value')
        .eq('key', key)
        .eq('shared', true)
        .maybeSingle();
      if (error) throw error;
      if (data) return { key, value: typeof data.value === 'string' ? data.value : JSON.stringify(data.value), shared };

      /* 既存の localStorage データがあれば、初回だけ共有 DB へ移行する。 */
      try {
        const old = await local.get(key, true);
        await this.set(key, old.value, true);
        return old;
      } catch {
        throw new Error(`storage: key not found: ${key}`);
      }
    },

    async set(key, value, shared = false) {
      if (!shared) return local.set(key, value, false);
      let jsonValue;
      try { jsonValue = JSON.parse(value); } catch { jsonValue = value; }
      const { error } = await supabase.from(TABLE).upsert({
        key, value: jsonValue, shared: true, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return { key, value, shared };
    },

    async delete(key, shared = false) {
      if (!shared) return local.delete(key, false);
      const { error } = await supabase.from(TABLE).delete().eq('key', key).eq('shared', true);
      if (error) throw error;
      return { key, deleted: true, shared };
    },

    async list(prefix = '', shared = false) {
      if (!shared) return local.list(prefix, false);
      const { data, error } = await supabase
        .from(TABLE)
        .select('key')
        .eq('shared', true)
        .like('key', `${prefix}%`);
      if (error) throw error;
      return { keys: (data ?? []).map((row) => row.key), prefix, shared };
    },
  };
}

function install() {
  if (typeof window === 'undefined') return;
  if (window.storage) return; // 本物の環境（Claude Artifacts）では上書きしない

  const local = localStorageApi();
  const remote = supabase ? supabaseStorageApi(local) : local;
  window.storage = {
    async get(key, shared = false) {
      try { return await remote.get(key, shared); } catch (error) {
        if (!supabase || !shared) throw error;
        warnFallback(error);
        return local.get(key, shared);
      }
    },
    async set(key, value, shared = false) {
      try { return await remote.set(key, value, shared); } catch (error) {
        if (!supabase || !shared) throw error;
        warnFallback(error);
        return local.set(key, value, shared);
      }
    },
    async delete(key, shared = false) {
      try { return await remote.delete(key, shared); } catch (error) {
        if (!supabase || !shared) throw error;
        warnFallback(error);
        return local.delete(key, shared);
      }
    },
    async list(prefix = '', shared = false) {
      try { return await remote.list(prefix, shared); } catch (error) {
        if (!supabase || !shared) throw error;
        warnFallback(error);
        return local.list(prefix, shared);
      }
    },
  };
}

install();
