// protocol/ — atelier/2 wire format as code (PLAN §4.4, §4.3 OR19). Pure functions only:
// no http, no sqlite, no ws. Every module has a vector file under ./vectors that a second
// implementation (the spine, the host) runs against — see README.md for the contract.
export const PROTOCOL = 'atelier/2'
