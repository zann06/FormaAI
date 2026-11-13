/**
 * Fills the template's own screenshot boxes with the matching source image.
 *
 * Real campus templates do not ask for a figure with a sentence — they reserve a
 * dashed-border table cell as a slot, containing an instruction such as
 * "[ TEMPELKAN SCREENSHOT: Diagram Topologi Lengkap Cisco Packet Tracer ]" followed
 * by a smaller "Pastikan screenshot diambil dengan resolusi jelas…" hint. The caption
 * ("Gambar 1. Arsitektur Topologi…") sits in the next paragraph.
 *
 * Those boxes were previously ignored, so the assembler appended every figure after
 * the section's prose. The shipped report then had an empty dashed box where a
 * picture belonged and the same picture floating paragraphs away — which is exactly
 * what the user reported. This module closes that loop: the image goes INSIDE the
 * box, the instruction text is removed, and the caption beneath it stays where the
 * template put it.
 *
 * Matching is by instruction text, not by order. A slot saying "Diagram Topologi"
 * only accepts an image whose OCR mentions topology, so the wiring diagram cannot
 * land in the OSPF-neighbour box.
 */
import { findAll, paragraphText, type XmlNode } from './xml.js';

/** The instruction that fills a reserved screenshot slot. */
export const SCREENSHOT_PROMPT = /(?:\[\s*)?TEMPELKAN\s+SCREENSHOT\s*:\s*([^\]]+?)\s*(?:\]|Pastikan|$)/i;

/**
 * True when a node's text carries a "paste a screenshot here" instruction.
 *
 * Word may split the prompt across runs, so this only looks for the marker itself
 * rather than the whole bracketed phrase.
 */
export function isScreenshotSlotText(text: string): boolean {
  return /TEMPELKAN\s+SCREENSHOT\s*:/i.test(text);
}

/** Words too generic to prove a figure belongs to a slot. */
const SLOT_STOPWORDS = new Set([
  'tempelkan', 'screenshot', 'diambil', 'dengan', 'resolusi', 'jelas', 'teks',
  'terbaca', 'utuh', 'tidak', 'terpotong', 'pastikan', 'pada', 'dan', 'dari',
  'yang', 'untuk', 'output', 'hasil', 'tampilan', 'panel', 'gambar', 'cli',
  'menu', 'pada', 'sebuah', 'atau', 'serta', 'the', 'and', 'for', 'from',
  'with', 'show', 'ip', 'command', 'prompt',
]);

/**
 * Pulls the subject out of a slot instruction.
 *
 * "[ TEMPELKAN SCREENSHOT: Output CLI: 'show ip interface brief' pada Router 1 dan
 * Router 2 ]" yields the distinctive terms `show ip interface brief`, `router`,
 * `interface`, `brief` — which is what an OCR'd screenshot of that command contains.
 */
/**
 * A template's instruction may carry XML/HTML entities, so "SSID &amp; Security"
 * would never match the wireless concept and "Services -&gt; DHCP" never matches DHCP.
 * Decoding is cheap and removes a whole class of silent mismatch.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

export function slotKeywords(text: string): string[] {
  const match = SCREENSHOT_PROMPT.exec(text);
  const subject = decodeEntities(match?.[1] ?? text).toLowerCase();
  const words = subject
    .split(/[^a-z0-9/._-]+/)
    .map((word) => word.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((word) => word.length >= 3 && !SLOT_STOPWORDS.has(word));
  return Array.from(new Set(words));
}

/**
 * Concept groups: what a slot asks for, expressed as signals in a picture's OCR.
 *
 * Literal keyword matching alone is not enough. A slot reading "Diagram Topologi
 * Lengkap Cisco Packet Tracer" asks for a diagram, and OCR of a diagram never
 * contains the word "topologi" — it contains the device labels the diagram draws
 * ("Router", "2960", "Fa0/1", "Server-PT"). This table turns those drawn labels back
 * into the concept the slot named, so a picture of a network can be recognised as a
 * topology even though nobody wrote the word on it.
 */
const SLOT_CONCEPTS: Array<{ slot: RegExp; signals: RegExp; label: string }> = [
  {
    // A topology diagram draws devices and their connections.
    slot: /topolog|diagram\s+jaringan|arsitektur\s+jaringan|skema\s+jaringan/i,
    signals:
      /\b(router|switch|server-?pt|pc-?pt|laptop-?pt|smartphone-?pt|access\s?point|fa\d\/\d|gi\d|gigabitethernet|serial\d|se0\/|console|2960|1941|2911)\b/i,
    label: 'topologi',
  },
  {
    // A CLI capture is a terminal transcript: a prompt, then tabular output.
    slot: /output\s+cli|show\s+\w|command|perintah\s+cli|terminal/i,
    signals: /\b(show\s|ip\s+address|interface|status|protocol|administratively|unassigned|method)\b/i,
    label: 'cli',
  },
  {
    // Wireless settings live in a GUI form: band, channel, encryption, passphrase.
    // Signals are chosen from what such a panel RENDERS, which OCR reads as separate
    // tokens — the slot's own words ("wpa2-psk") are hyphenated and never match OCR.
    slot: /wireless|wifi|nirkabel|ssid|wpa\w*|access\s?point|wlc/i,
    signals:
      /(ssid|wpa2?psk|wpapsk|wep|channel|encryption\s+type|pass\s?phrase|\d\s?ghz|authentication)/i,
    label: 'wireless',
  },
  {
    // Routing tables are lists of prefixes and next hops.
    slot: /routing|rute|ospf|rip|eigrp|bgp|neighbor|tetangga/i,
    signals: /\b(ospf|rip|eigrp|bgp|neighbor|next\s?hop|metric|network|state|full|2way)\b/i,
    label: 'routing',
  },
  {
    // A ping/connectivity test reports replies and loss.
    slot: /ping|konektivitas|traceroute|latency|paket\s+hilang/i,
    signals: /\b(ping|reply|bytes|ttl|time|loss|succeeded|traceroute|hops?)\b/i,
    label: 'ping',
  },
  {
    // DHCP leases list address bindings.
    slot: /dhcp|lease|ip\s+pool|alamat\s+otomatis/i,
    signals: /\b(dhcp|lease|pool|binding|gateway|dns|excluded)\b/i,
    label: 'dhcp',
  },
];

/**
 * A picture that draws a network is a topology, whether or not OCR read the word.
 *
 * Counts distinct device/gateway signals so a busy diagram must show several before
 * it is claimed — one stray "Fa0/1" in an unrelated screenshot is not a topology.
 */
function topologyStrength(figureText: string): number {
  const matches = figureText.match(
    /\b(router\w*|switch\w*|server-?pt|pc-?pt|laptop-?pt|smartphone-?pt|access\s?point|fa\d\/\d|gi\d|gigabitethernet|serial\d|2960|1941|2911)\b/gi,
  );
  if (!matches) return 0;
  return new Set(matches.map((m) => m.toLowerCase())).size;
}

/**
 * Scores how well a figure's OCR text answers a slot's instruction.
 *
 * Weighting is deliberate:
 *   - a literal keyword hit is worth 1;
 *   - a CONCEPT the slot names (wireless panel, DHCP menu, routing table…) is worth
 *     much more, because it is what the box is actually about;
 *   - a picture that draws a network answers "Diagram Topologi" even though its OCR
 *     never says "topologi".
 *
 * Zero means "not this one". A single incidental word must not win a box: the wireless
 * panel slot used to be filled by any screenshot whose OCR happened to contain "access
 * point", including a topology diagram that merely drew one.
 */
export function scoreFigureForSlot(slotText: string, figureText: string): number {
  const decodedSlot = decodeEntities(slotText);
  const keywords = slotKeywords(slotText);
  const haystack = figureText.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 1;
  }

  // Concept groups: when the slot names one, the picture must carry at least two of
  // that concept's DISTINCTIVE signals, and the reward outweighs stray keyword hits.
  for (const concept of SLOT_CONCEPTS) {
    if (!concept.slot.test(decodedSlot)) continue;
    const hits = figureText.match(new RegExp(concept.signals.source, 'gi'));
    const distinct = hits ? new Set(hits.map((hit) => hit.toLowerCase())).size : 0;
    if (distinct >= 2) score += 5 + Math.min(distinct, 5);
  }

  // A slot's CONCEPT can be satisfied by what the picture draws, not only by what it
  // writes. "Diagram Topologi" is answered by a screenshot full of Router/Switch/PC
  // labels even though its OCR never says "topologi".
  if (/\btopolog|\bdiagram\b/i.test(decodedSlot)) {
    const strength = topologyStrength(figureText);
    if (strength >= 3) score += Math.min(strength, 6);
  }
  return score;
}

export interface FigureCandidate {
  /** Identity of the source document (an image file). */
  documentId: string;
  /** OCR text of that image, used to decide which slot it belongs in. */
  text: string;
}

export interface SlotMatch {
  /** The <w:tbl> that forms the dashed box. */
  node: XmlNode;
  slotText: string;
  documentId: string;
  score: number;
}

/**
 * Finds the screenshot slots in document order.
 *
 * A slot is a table whose text carries the instruction — the template wraps the
 * reserved area in a bordered one-cell table rather than a plain paragraph, which is
 * why it survived every previous attempt to replace placeholder text.
 */
export function findScreenshotSlots(body: XmlNode, sectionParagraphRange: [number, number]): XmlNode[] {
  const slots: XmlNode[] = [];
  const children = body.children;
  for (let index = sectionParagraphRange[0]; index < Math.min(sectionParagraphRange[1], children.length); index += 1) {
    const node = children[index]!;
    const text = collectText(node);
    if (isScreenshotSlotText(text)) slots.push(node);
  }
  return slots;
}

/**
 * Assigns figures to slots, one figure per slot, maximising TOTAL match quality.
 *
 * Greedy "best pair first" is not good enough. Two boxes can both accept the same
 * screenshot at the same score — a topology diagram and a laptop screenshot both
 * mention a laptop — and whichever pair happened to be generated first then won.
 * That is exactly how the user's topology box got an unrelated picture while the real
 * diagram went to the wireless box.
 *
 * So this solves the assignment problem properly: pick the set of (slot, figure) pairs
 * that maximises the sum of scores with no slot or figure used twice. With at most a
 * few dozen boxes the Hungarian algorithm is unnecessary — a greedy start followed by
 * exhaustive pairwise swaps converges on the optimum here and is far easier to read.
 *
 * A figure whose every candidate score is 0 is left unused rather than stuffed into an
 * arbitrary box: an empty box is honest, a wrong picture is a lie.
 */
export function matchFiguresToSlots(
  slots: Array<{ node: XmlNode; slotText: string }>,
  figures: FigureCandidate[],
): { matches: SlotMatch[]; unusedFigures: FigureCandidate[] } {
  if (slots.length === 0 || figures.length === 0) {
    return { matches: [], unusedFigures: figures };
  }

  // score[slotIndex][figureIndex], 0 meaning "no claim".
  const score: number[][] = slots.map((slot) =>
    figures.map((figure) => scoreFigureForSlot(slot.slotText, figure.text)),
  );

  // Best valid pairing per slot: the figure that scores highest for it. Ties are not
  // resolved here; the swap pass below fixes collisions globally.
  const assign: number[] = slots.map((_, slotIndex) => {
    let best = -1;
    let bestScore = 0;
    for (let figureIndex = 0; figureIndex < figures.length; figureIndex += 1) {
      const value = score[slotIndex]![figureIndex] ?? 0;
      if (value > bestScore) {
        bestScore = value;
        best = figureIndex;
      }
    }
    return best;
  });

  // Resolve collisions: if two slots want the same figure, the lower-scoring claim
  // moves to its next-best free figure. Repeating until stable gives the maximum total.

  // Greedy seed: take pairs from highest score down, skipping used slots/figures. This
  // already guarantees no duplicates, which the per-slot pass does not.
  const pairs: Array<{ slotIndex: number; figureIndex: number; value: number }> = [];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    for (let figureIndex = 0; figureIndex < figures.length; figureIndex += 1) {
      const value = score[slotIndex]![figureIndex] ?? 0;
      if (value > 0) pairs.push({ slotIndex, figureIndex, value });
    }
  }
  pairs.sort((a, b) => b.value - a.value);
  const seeded = slots.map(() => -1);
  const seededFigures = new Set<number>();
  for (const pair of pairs) {
    if (seeded[pair.slotIndex]! >= 0 || seededFigures.has(pair.figureIndex)) continue;
    seeded[pair.slotIndex] = pair.figureIndex;
    seededFigures.add(pair.figureIndex);
  }

  // Improvement pass: repeatedly apply any swap that raises the total. A swap means
  // "slot A takes figure B's figure while slot B takes A's", which is how a tie is
  // broken correctly — the pair of moves is only accepted if the sum goes up.
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let a = 0; a < slots.length; a += 1) {
      for (let b = a + 1; b < slots.length; b += 1) {
        const figA = seeded[a]!;
        const figB = seeded[b]!;
        const current = (figA >= 0 ? (score[a]![figA] ?? 0) : 0) + (figB >= 0 ? (score[b]![figB] ?? 0) : 0);
        const swapped = (figB >= 0 ? (score[a]![figB] ?? 0) : 0) + (figA >= 0 ? (score[b]![figA] ?? 0) : 0);
        if (swapped > current) {
          seeded[a] = figB;
          seeded[b] = figA;
          improved = true;
        }
      }
    }
  }

  const matches: SlotMatch[] = [];
  const usedFigures = new Set<string>();
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    const figureIndex = seeded[slotIndex]!;
    if (figureIndex < 0) continue;
    const figure = figures[figureIndex]!;
    const value = score[slotIndex]![figureIndex] ?? 0;
    if (value <= 0) continue;
    usedFigures.add(figure.documentId);
    matches.push({
      node: slots[slotIndex]!.node,
      slotText: slots[slotIndex]!.slotText,
      documentId: figure.documentId,
      score: value,
    });
  }

  return { matches, unusedFigures: figures.filter((figure) => !usedFigures.has(figure.documentId)) };
}

function collectText(node: XmlNode): string {
  if (node.tag === '#text') return node.text ?? '';
  let out = '';
  for (const child of node.children) out += collectText(child);
  return out;
}

/** Convenience: the text of the first slot inside a node, for logging. */
export function slotTextOf(node: XmlNode): string {
  return collectText(node);
}

/** All body children, so callers can compute a section's index range. */
export function bodyChildren(body: XmlNode): XmlNode[] {
  return body.children;
}

export { findAll, paragraphText };
