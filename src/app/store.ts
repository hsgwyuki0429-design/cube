// 小さな状態ストア（購読 + セレクタ）。フレームごとに変わるもの（映像の検出結果）はここに入れず、
// 描画側が直接購読する。
import { useEffect, useReducer, useRef } from "preact/hooks";

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: (s: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(s: T) => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      for (const l of listeners) l(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  const value = selector(store.get());
  const last = useRef(value);
  last.current = value;
  useEffect(
    () =>
      store.subscribe((s) => {
        const next = sel.current(s);
        if (!shallowEqual(next, last.current)) force(0);
      }),
    [store],
  );
  return value;
}
