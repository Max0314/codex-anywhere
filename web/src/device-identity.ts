import {
  createDeviceAuthProof,
  createDeviceIdentity,
  type DeviceIdentity,
} from '../../src/shared/device-auth';
import type { AuthRole } from '../../src/shared/auth';

const STORAGE_KEY = 'codex-anywhere.device-identity.v1';
const APPROVED_KEY = 'codex-anywhere.device-approved.v1';
let memoryIdentity: DeviceIdentity | null = null;

function validStoredIdentity(value: unknown): value is DeviceIdentity {
  if (!value || typeof value !== 'object') return false;
  try {
    const candidate = value as DeviceIdentity;
    const rebuilt = createDeviceIdentity(candidate.privateKey);
    return rebuilt.id === candidate.id && rebuilt.publicKey === candidate.publicKey;
  } catch {
    return false;
  }
}

export type BrowserAccount = { key: string; migrateLegacy: boolean; identity: DeviceIdentity };

const accountIdentities = new Map<string, Promise<DeviceIdentity>>();

export function prepareAccountIdentity(key: string, migrateLegacy: boolean): Promise<DeviceIdentity> {
  const pending = accountIdentities.get(key);
  if (pending) return pending;
  const open = new Promise<DeviceIdentity>((resolve, reject) => {
    const request = indexedDB.open('codex-anywhere-account-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('identity');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('identity', 'readwrite');
      const bucket = transaction.objectStore('identity');
      const read = bucket.get(key);
      let identity: DeviceIdentity;
      read.onsuccess = () => {
        if (validStoredIdentity(read.result)) {
          identity = read.result;
          return;
        }
        let legacy: unknown;
        if (migrateLegacy) {
          try { legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* no reusable identity */ }
        }
        identity = validStoredIdentity(legacy) ? legacy : createDeviceIdentity();
        bucket.put(identity, key);
      };
      transaction.oncomplete = () => { db.close(); resolve(identity); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
  const identity = open.catch(error => { accountIdentities.delete(key); throw error; });
  accountIdentities.set(key, identity);
  return identity;
}

export function loadOrCreateBrowserDeviceIdentity() {
  if (memoryIdentity) return memoryIdentity;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as unknown;
    if (validStoredIdentity(stored)) {
      memoryIdentity = stored;
      return stored;
    }
  } catch {
    // A missing, corrupt, or blocked store gets a fresh page-lifetime identity.
  }
  const identity = createDeviceIdentity();
  memoryIdentity = identity;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(identity)); } catch { /* private mode */ }
  return identity;
}

function browserDeviceLabel() {
  const platform = String(navigator.platform || '').trim();
  return platform ? `Web · ${platform}` : 'Web browser';
}

export function createBrowserDeviceProof(params: {
  challenge: string;
  role: AuthRole;
  authProof: string;
  routeDeviceId?: string;
}, identity = loadOrCreateBrowserDeviceIdentity()) {
  return createDeviceAuthProof(identity, params, browserDeviceLabel());
}

export function hasApprovedBrowserDevice() {
  try { return localStorage.getItem(APPROVED_KEY) === '1'; } catch { return false; }
}

export function markBrowserDeviceApproved() {
  try { localStorage.setItem(APPROVED_KEY, '1'); } catch { /* private mode */ }
}

export function clearBrowserDeviceApproval() {
  try { localStorage.removeItem(APPROVED_KEY); } catch { /* private mode */ }
}
