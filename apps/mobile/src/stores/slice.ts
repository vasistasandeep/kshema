/**
 * Minimal Zustand-compatible slice primitives.
 *
 * Zustand's `create(set, get => state)` signature is reproduced here with tiny
 * local types so slice logic is framework-agnostic: each slice is a plain
 * function of `(set, get)` that returns state + actions. This lets the reducers
 * be unit-tested under Node without pulling in the `zustand` runtime (the real
 * `create()` bindings live in `./index.ts`, which is part of the RN app
 * typecheck). Zustand's actual `set`/`get` are structurally compatible with
 * these types.
 */

/** Partial-or-full state updater, matching Zustand's `set`. */
export type SetState<T> = (
  partial: Partial<T> | ((state: T) => Partial<T>),
) => void;

/** Current-state reader, matching Zustand's `get`. */
export type GetState<T> = () => T;

/** A slice creator: `(set, get) => sliceState`. */
export type SliceCreator<T> = (set: SetState<T>, get: GetState<T>) => T;

/**
 * Drive a {@link SliceCreator} with a plain in-memory backing store. Returns the
 * live state object plus a snapshot reader — enough to unit-test slice actions
 * without the zustand runtime.
 */
export function createTestStore<T>(creator: SliceCreator<T>): {
  getState: GetState<T>;
} {
  let state = {} as T;
  const get: GetState<T> = () => state;
  const set: SetState<T> = (partial) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  state = creator(set, get);
  return { getState: get };
}
