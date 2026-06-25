// ReactDOM shim — same idea as ./react.js. Many UI libraries use
// `import { createPortal } from 'react-dom'`; aliasing 'react-dom' to this
// file routes them to the global UMD ReactDOM.
const RD = (typeof window !== 'undefined' && window.ReactDOM) || globalThis.ReactDOM;
if (!RD) throw new Error('atelier/shims/react-dom.js: window.ReactDOM not loaded yet');
export default RD;
export const { createPortal, flushSync, findDOMNode, version } = RD;
