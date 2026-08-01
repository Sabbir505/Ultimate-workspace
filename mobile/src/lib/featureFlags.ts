import { useState, useEffect } from 'react';

const KEY = 'feature.useChatSession';
let cache: boolean | null = null;
const listeners = new Set<(v: boolean) => void>();
const memoryStore = new Map<string, string>();
let warningLogged = false;
let storageImpl: AsyncStorageLike | null = null;

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

async function loadStorage(): Promise<AsyncStorageLike> {
  if (storageImpl) return storageImpl;
  try {
    const mod = '@react' + '-native-async-storage/async-storage';
    const resolved = await import(/* @vite-ignore */ mod);
    storageImpl = resolved.default ?? resolved;
  } catch {
    if (!warningLogged) {
      console.warn('AsyncStorage not available; using in-memory storage only');
      warningLogged = true;
    }
    storageImpl = {
      getItem: async (k: string) => memoryStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { memoryStore.set(k, v); },
    };
  }
  return storageImpl;
}

export async function getUseChatSession(): Promise<boolean> {
  if (cache !== null) return cache;
  const store = await loadStorage();
  const raw = await store.getItem(KEY);
  cache = raw === '1';
  return cache;
}

export async function setUseChatSession(v: boolean): Promise<void> {
  cache = v;
  const store = await loadStorage();
  await store.setItem(KEY, v ? '1' : '0');
  listeners.forEach((fn) => fn(v));
}

function useStateLocal(initial: boolean): [boolean, (v: boolean) => void] {
  return useState(initial);
}

export function useUseChatSession(): boolean {
  const [v, setV] = useStateLocal(cache ?? false);
  useEffect(() => {
    const fn = (next: boolean) => setV(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return v;
}