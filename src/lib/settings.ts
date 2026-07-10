import { Store } from '@tauri-apps/plugin-store';

const STORE_FILE = 'omnibridge.settings.json';
const KEY_API_KEY = 'anthropic_api_key';

/** Kunci default dari build-time env — diisi lewat .env saat development/build. */
const KUNCI_DEFAULT = (import.meta.env.VITE_ANTHROPIC_API_KEY as string) || '';

let _store: Store | null = null;
let _sudahSeedDefault = false;

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

    // Seed kunci default ke store sekali agar tidak perlu diisi manual tiap buka app
    if (KUNCI_DEFAULT && !_sudahSeedDefault) {
      _sudahSeedDefault = true;
      await store.set(KEY_API_KEY, KUNCI_DEFAULT);
      await store.save();
      return KUNCI_DEFAULT;
    }
  } catch {
    // store not available (e.g. browser preview)
  }

  return KUNCI_DEFAULT || null;
}

export async function setApiKey(key: string): Promise<void> {
  const store = await getStore();
  await store.set(KEY_API_KEY, key);
  await store.save();
}

export async function clearApiKey(): Promise<void> {
  const store = await getStore();
  await store.delete(KEY_API_KEY);
  await store.save();
}
