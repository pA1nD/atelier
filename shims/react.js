// React shim — re-exports the global React (UMD on window) so bundled
// chromes (esbuild bundles with alias: { react: <this file> }) share the
// same React instance as the shell. Multiple React instances break
// Headless UI's hooks and Suspense, so this alignment matters.
const R = (typeof window !== 'undefined' && window.React) || globalThis.React;
if (!R) throw new Error('atelier/shims/react.js: window.React not loaded yet');
export default R;
export const {
  Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createElement, createFactory, createRef,
  forwardRef, isValidElement, lazy, memo, startTransition,
  useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId,
  useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo,
  useReducer, useRef, useState, useSyncExternalStore, useTransition,
  version,
  // Internal hooks some libs reach for. Re-export defensively as undefined-
  // tolerant — if the underlying React lacks them, consumers fall back.
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,
} = R;
