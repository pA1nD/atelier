// JSX automatic-runtime shim — same React instance as the shell.
// esbuild's `jsx: 'automatic'` rewrites `<div />` into calls into
// `react/jsx-runtime`'s `jsx`/`jsxs`/`Fragment`. We alias that to this
// file so the JSX nodes go through window.React.createElement, which is
// the same renderer the shell uses.
const R = (typeof window !== 'undefined' && window.React) || globalThis.React;
if (!R) throw new Error('atelier/shims/jsx-runtime.js: window.React not loaded yet');

export const Fragment = R.Fragment;

function jsxImpl(type, props, key) {
  if (key !== undefined) {
    const next = { ...props };
    next.key = key;
    return R.createElement(type, next);
  }
  return R.createElement(type, props);
}

export const jsx = jsxImpl;
export const jsxs = jsxImpl;
export const jsxDEV = jsxImpl;
