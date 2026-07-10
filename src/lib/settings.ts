import { Store } from '@tauri-apps/plugin-store';

const STORE_FILE = 'omnibridge.settings.json';
const KEY_API_KEY = 'anthropic_api_key';

/** Kunci dev-only — tidak di-inline ke release build (hanya saat import.meta.env.DEV). */
const KUNCI_DEV = import.meta.env.DEV
  ? ((import.meta.env.VITE_ANTHROPIC_API_KEY as string) || '')
  : '';

let _store: Store | null = null;
let _sudahSeedDefault = false;
let _dihapusUser = false;

async function getStore(): Promise<Store> {
  if (!_store) {
    _store = await Store.load(STORE_FILE);
  }
  return _store;
}

export async function getApiKey(): Promise<string | null> {
  try {
    const store = await getStore();
    const stored = await store.get<string>(KEY_API_KEY);
    if (stored) return stored;

    // Seed kunci dev ke store sekali — hanya mode development
    if (import.meta.env.DEV && KUNCI_DEV && !_sudahSeedDefault && !_dihapusUser) {
      _sudahSeedDefault = true;
      await store.set(KEY_API_KEY, KUNCI_DEV);
      await store.save();
      return KUNCI_DEV;
    }
  } catch {
    // store not available (e.g. browser preview)
  }

  // Fallback env hanya di dev; release build tidak pernah bawa kunci developer
  if (import.meta.env.DEV && KUNCI_DEV && !_dihapusUser) {
    return KUNCI_DEV;
  }
  return null;
}

export async function setApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY_API_KEY, key);
  await store.save();
  _dihapusUser = false;
}

export async function clearApiKey(): Promise<void> {
  const store = await getStore();
  await store.delete(KEY_API_KEY);
  await store.save();
  _dihapusUser = true;
}
