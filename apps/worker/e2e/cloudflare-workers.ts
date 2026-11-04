// What `cloudflare:workers` resolves to when an e2e suite imports Worker source into Node (the
// route table in `billing-gate.e2e.test.ts`). Durable Object classes only extend it there; none
// is constructed and no request runs through it: the suites still call the real Worker in workerd.
export class DurableObject {}
