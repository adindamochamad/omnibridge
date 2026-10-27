import { Store } from '@tauri-apps/plugin-store';
import { KUNCI_META_MODEL_API_DEFAULT } from './konfigurasi-default-cas.js';
import { metaKeyClass, usableMetaKey } from './meta-api.js';

export { metaKeyClass, usableMetaKey };

const STORE_FILE = 'omnibridge.settings.json';
const KEY_API_KEY = 'meta_model_api_key';
const KEY_API_KEY_LEGACY = 'anthropic_api_key';

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
    const legacy = await store.get<string>(KEY_API_KEY_LEGACY);
    const chosen = usableMetaKey(stored) ?? usableMetaKey(legacy);
    if (chosen) return chosen;

    if (usableMetaKey(KUNCI_META_MODEL_API_DEFAULT) && !_sudahSeedDefault && !_dihapusUser) {
      _sudahSeedDefault = true;
      const seeded = usableMetaKey(KUNCI_META_MODEL_API_DEFAULT)!;
      await store.set(KEY_API_KEY, seeded);
      await store.save();
      return seeded;
    }
  } catch {
    // store tidak tersedia (mis. preview browser)
  }

  const fromEnv = usableMetaKey(KUNCI_META_MODEL_API_DEFAULT);
  if (fromEnv && !_dihapusUser) {
    return fromEnv;
  }
  return null;
}

export async function setApiKey(key: string): Promise<void> {
  const usable = usableMetaKey(key);
  if (!usable) {
    throw new Error(
      'That key is not a Meta Model API key. Paste a Standard key from dev.meta.ai. It starts with LLM_.',
    );
  }
  const store = await getStore();
  await store.set(KEY_API_KEY, usable);
  await store.save();
  _dihapusUser = false;
}

export async function clearApiKey(): Promise<void> {
  const store = await getStore();
  await store.delete(KEY_API_KEY);
  await store.save();
  _dihapusUser = true;
}
