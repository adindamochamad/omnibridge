import { Store } from '@tauri-apps/plugin-store';
import { KUNCI_API_ANTHROPIC_DEFAULT } from './konfigurasi-default-cas.js';

const STORE_FILE = 'omnibridge.settings.json';
const KEY_API_KEY = 'anthropic_api_key';

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

    // Seed kunci bawaan sekali (dari .env saat build atau konstanta internal)
    if (KUNCI_API_ANTHROPIC_DEFAULT && !_sudahSeedDefault && !_dihapusUser) {
      _sudahSeedDefault = true;
      await store.set(KEY_API_KEY, KUNCI_API_ANTHROPIC_DEFAULT);
      await store.save();
      return KUNCI_API_ANTHROPIC_DEFAULT;
    }
  } catch {
    // store tidak tersedia (mis. preview browser)
  }

  if (KUNCI_API_ANTHROPIC_DEFAULT && !_dihapusUser) {
    return KUNCI_API_ANTHROPIC_DEFAULT;
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
