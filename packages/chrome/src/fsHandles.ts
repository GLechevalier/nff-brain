// The ONE module that touches IndexedDB — the IDB sibling of storage.ts's
// chrome.storage monopoly. It exists because a FileSystemDirectoryHandle is
// structured-cloneable but NOT JSON-serializable: it can live in IndexedDB and
// be picked up again by the service worker, but it can never ride
// chrome.storage.local with the rest of the persisted contract (schema.ts
// keeps only the JSON metadata, KEYS.codeProject).
//
// The side panel writes the handle (window.showDirectoryPicker needs a user
// gesture in a window context); the SW reads it back for the code tools.
// Permission REQUESTS also need a window + gesture, so requestPermission runs
// panel-side ("Re-grant") — the SW only ever queries.
//
// No module-level state: the DB connection is opened per call and closed in a
// finally, so worker death can never strand a half-open connection.

const DB_NAME = 'nb-code';
const STORE = 'handles';
const PROJECT_KEY = 'project';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** Persist the picked project folder handle (side panel only — the gesture context). */
export async function putProjectHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (s) => s.put(handle, PROJECT_KEY));
}

/** NEVER THROWS. The stored handle, or null when none/unreadable. */
export async function getProjectHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const v = await withStore<unknown>('readonly', (s) => s.get(PROJECT_KEY) as IDBRequest<unknown>);
    // Trust the shape, not the class name: a structured-clone round trip keeps
    // the methods, and duck-typing survives realm differences.
    if (v && typeof (v as FileSystemDirectoryHandle).getDirectoryHandle === 'function') {
      return v as FileSystemDirectoryHandle;
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearProjectHandle(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(PROJECT_KEY) as IDBRequest<undefined>);
}

/** 'missing' = no handle stored; the rest mirror PermissionState for readwrite. */
export type ProjectPermission = 'granted' | 'prompt' | 'denied' | 'missing';

/** NEVER THROWS. Query (never request) the readwrite permission on the stored handle. */
export async function queryProjectPermission(): Promise<ProjectPermission> {
  const handle = await getProjectHandle();
  if (!handle) return 'missing';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}
