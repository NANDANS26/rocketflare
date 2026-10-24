/**
 * Recipient-address helpers for the inbound email seam (`api/email.ts`), in a LEAF module with no
 * imports so `@/plugins/api` can re-export them without reading the plugin barrel — `api/email.ts`
 * reads it at module scope, and a plugin importing that module back would close a cycle.
 */

/** The catch-all local part. */
export const EMAIL_CATCH_ALL = '*'

/**
 * `Receipts+Proton@Example.com` → `receipts`. Lower-cased (local parts are case-insensitive in
 * practice, and Email Routing matches them that way) and cut at the first `+`, which is the
 * subaddress separator Email Routing understands.
 */
export function emailLocalPart(address: string): string {
  const at = address.lastIndexOf('@')
  const local = (at === -1 ? address : address.slice(0, at)).trim().toLowerCase()
  const plus = local.indexOf('+')
  return plus === -1 ? local : local.slice(0, plus)
}

/** `receipts+proton@example.com` → `proton`; null when the address carries no tag. */
export function emailSubaddress(address: string): string | null {
  const at = address.lastIndexOf('@')
  const local = (at === -1 ? address : address.slice(0, at)).trim().toLowerCase()
  const plus = local.indexOf('+')
  return plus === -1 || plus === local.length - 1 ? null : local.slice(plus + 1)
}
