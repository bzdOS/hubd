/* mail.mjs — the artifacts a mail relay delivered, as the journal records them.
 *
 * The relay (a fleet tool, not hubd) writes one journal entry per delivery that succeeded, kind
 * `delivery` (`hub report -k delivery`), its text:
 *   "<sender> → <recipient>: <name> <bytes> B sha256 <hex>"
 * where the byte unit is a Latin B or a Cyrillic one (U+0411), and -> reads as →. Live shows the newest MAIL_LIMIT of them as a row of
 * their own, apart from the activity feed; the Summary gives each track the newest MAIL_LIMIT whose
 * recipient is one of its roles. An entry of the kind whose text does not read so stays whole, with
 * sender, recipient and the rest null: what it meant is not guessed, and with no recipient it
 * belongs to no track.
 */
export const MAIL_LIMIT = 20;
export const DELIVERY = 'delivery';

const LINE_RE = /^(\S+) (?:→|->) (\S+): (.+?) (\d+) (?:\u0411|B) sha256 ([0-9a-f]{12,64})$/;
const NONE = { from: null, to: null, name: null, bytes: null, sha256: null };

/** What a delivery entry's text says: { from, to, name, bytes, sha256 }, or null if it does not read. */
export function parseDelivery(text) {
  const m = LINE_RE.exec(String(text ?? '').trim());
  return m ? { from: m[1], to: m[2], name: m[3], bytes: Number(m[4]), sha256: m[5] } : null;
}

/** The deliveries among journal entries, in the order given:
 *  { ts, project, agent, from, to, name, bytes, sha256, text }. */
export function deliveries(entries) {
  return entries.filter(e => e && e.kind === DELIVERY).map(e => ({
    ts: e.ts ?? null, project: e.project ?? null, agent: e.agent ?? null,
    ...(parseDelivery(e.text) || NONE), text: String(e.text ?? ''),
  }));
}
