import { parseProject, STORAGE_KEY } from './project';
import type { TerrainProject } from './types';

const RASTER_SESSION = 'indexeddb:normal-height.session';
const STORE = 'projects';

async function openSessions(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('normal-height.sessions', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadLastSession(): Promise<TerrainProject | null> {
  const value = localStorage.getItem(STORAGE_KEY);
  if (!value) return null;
  if (value !== RASTER_SESSION) return parseProject(JSON.parse(value));
  const db = await openSessions();
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get('last');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return raw ? parseProject(raw) : null;
  } finally {
    db.close();
  }
}

// Raster projects can exceed localStorage's quota. Publish the pointer only
// after the database transaction commits, keeping the previous session usable
// if a quota error occurs. Ignore writes superseded during the debounce.
export async function autosaveProject(project: TerrainProject, current: () => boolean) {
  if (project.graph.nodes.some((node) => node.raster)) {
    try {
      const db = await openSessions();
      try {
        if (!current()) return;
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.objectStore(STORE).put(project, 'last');
        });
        if (current()) localStorage.setItem(STORAGE_KEY, RASTER_SESSION);
        return;
      } finally {
        db.close();
      }
    } catch {
      // Small imports can still be saved when the database is unavailable.
    }
  }
  if (current()) localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}
