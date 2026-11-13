/**
 * The template reserves a box for each screenshot and the writer must fill it.
 *
 * The delivered report showed a dashed box still reading
 * "[ TEMPELKAN SCREENSHOT: Diagram Topologi Lengkap Cisco Packet Tracer ]" while the
 * topology picture was pasted paragraphs away, and its caption ("Gambar 1. …") fell
 * onto a different page than its picture. The cause was structural: the box is a
 * one-cell table, and every figure was appended after the section's prose instead of
 * inside it.
 *
 * These tests pin slot matching, cell filling, and the leaving-alone of figures that
 * no box claims.
 */
import { describe, expect, it } from 'vitest';
import { assembleDocx } from '../src/assemble.js';
import { buildFixtureDocx, type FixtureOptions } from '../src/fixtures.js';
import { readDocxPackage, xmlToString } from '../src/zip.js';
import { findAll, findChild, parseXml, type XmlNode } from '../src/xml.js';
import {
  isScreenshotSlotText,
  matchFiguresToSlots,
  scoreFigureForSlot,
  slotKeywords,
} from '../src/screenshot-slots.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function tinyPng(): Uint8Array {
  return Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'));
}

/**
 * Builds a document shaped like the real template: a heading, prose, a dashed
 * screenshot box containing the instruction and its hint, and a caption below it.
 */
function slotTemplate(): Uint8Array {
  const body: FixtureOptions['body'] = [
    { text: 'BAB II PEMBAHASAN' },
    { text: '2.1 Topologi Jaringan' },
    { text: 'Jaringan ini menghubungkan dua router melalui tautan serial.' },
    {
      table: {
        rows: [
          [
            "[ TEMPELKAN SCREENSHOT: Diagram Topologi Lengkap Cisco Packet Tracer ] Pastikan screenshot diambil dengan resolusi jelas, teks terbaca utuh, dan tidak terpotong",
          ],
        ],
      },
    },
    { text: 'Gambar 1. Arsitektur Topologi Jaringan Multi-Router' },
    { text: '2.2 Verifikasi OSPF' },
    { text: 'Ketetanggaan OSPF diverifikasi dengan show ip ospf neighbor.' },
    {
      table: {
        rows: [
          [
            "[ TEMPELKAN SCREENSHOT: Output CLI: 'show ip ospf neighbor' pada Router 1 ] Pastikan screenshot diambil dengan resolusi jelas",
          ],
        ],
      },
    },
    { text: 'Gambar 2. Ketetanggaan OSPF' },
  ];
  return buildFixtureDocx({ body });
}

const TOPOLOGY_OCR = 'Diagram Topologi Jaringan R-KABEL Router1 GigabitEthernet0/0 Switch0 Server PC-0 Laptop Wireless Access Point';
const OSPF_OCR = 'R-KABEL>show ip ospf neighbor Neighbor ID Pri State Dead Time Address Interface 2.2.2.2 1 FULL/DR';

describe('screenshot slot detection', () => {
  it('recognises the instruction the template uses', () => {
    expect(isScreenshotSlotText('[ TEMPELKAN SCREENSHOT: Diagram Topologi ]')).toBe(true);
    expect(isScreenshotSlotText('tempelkan screenshot: apa saja')).toBe(true);
    expect(isScreenshotSlotText('Gambar 1. Arsitektur Topologi')).toBe(false);
  });

  it('extracts the distinctive subject from the instruction', () => {
    const keywords = slotKeywords("[ TEMPELKAN SCREENSHOT: Output CLI: 'show ip ospf neighbor' pada Router 1 ]");
    expect(keywords).toContain('ospf');
    expect(keywords).toContain('neighbor');
    // The prompt's own words must not become matching material.
    expect(keywords).not.toContain('tempelkan');
    expect(keywords).not.toContain('screenshot');
  });

  it('scores a matching screenshot above an unrelated one', () => {
    const slot = '[ TEMPELKAN SCREENSHOT: Diagram Topologi Lengkap Cisco Packet Tracer ]';
    expect(scoreFigureForSlot(slot, TOPOLOGY_OCR)).toBeGreaterThan(0);
    expect(scoreFigureForSlot(slot, OSPF_OCR)).toBe(0);
  });

  it('recognises a topology from the devices it draws, not the word', () => {
    // Real OCR of a Packet Tracer diagram never contains "topologi": it reads the
    // labels the diagram draws. This is the picture from the user's own project.
    const slot = '[ TEMPELKAN SCREENSHOT: Diagram Topologi Lengkap Cisco Packet Tracer ]';
    const drawnDiagram =
      'Gi90/0 1941 Roytert 2960p24TT Server-PT Fa0/1 Fa0/2 Access-Point Laptop-PT Smartphone-PT PC0 PC1';
    expect(scoreFigureForSlot(slot, drawnDiagram)).toBeGreaterThan(0);

    // A CLI transcript must NOT be mistaken for a diagram just because it names
    // an interface.
    const cli = "R-KABEL>show ip interface brief Interface IP-Address OK? Method Status Protocol GigabitEthernet0/0 192.168.10.97 YES manual up up";
    expect(scoreFigureForSlot(slot, cli)).toBe(0);
  });

  it('reads HTML entities in the instruction', () => {
    // Templates are DOCX XML; an instruction can arrive as "SSID &amp; Security",
    // which must still be recognised as the wireless-panel concept.
    const slot = '[ TEMPELKAN SCREENSHOT: Panel Konfigurasi Access Point (SSID &amp; Security WPA2-PSK) ]';
    const panel = 'Jarkom-WIFi 4 GHz Channel 8 Disabled WEP WPAPSK wpa2Psk PSK Pass Phrase Encryption Type';
    expect(scoreFigureForSlot(slot, panel)).toBeGreaterThan(3);

    // A diagram that merely DRAWS an access point must not win the wireless box.
    const diagram = 'Router1 Switch0 Access-Point Server-PT PC0 PC1 Laptop-PT Fa0/1 Gi0/0 2960';
    expect(scoreFigureForSlot(slot, diagram)).toBeLessThan(scoreFigureForSlot(slot, panel));
  });

  it('resolves a contested figure to the box that needs it most', () => {
    // Both boxes could take the diagram, but only one box has a better option, so the
    // diagram must go where nothing else fits. Greedy "first pair wins" got this wrong
    // and left the real topology box holding an unrelated screenshot.
    const slots = [
      { node: { tag: 'a', children: [] } as never, slotText: '[ TEMPELKAN SCREENSHOT: Diagram Topologi ]' },
      { node: { tag: 'b', children: [] } as never, slotText: '[ TEMPELKAN SCREENSHOT: Panel Wireless SSID ]' },
    ];
    const { matches } = matchFiguresToSlots(slots, [
      { documentId: 'diagram', text: TOPOLOGY_OCR },
      { documentId: 'panel', text: 'SSID Jarkom 4 GHz Channel 8 WEP WPAPSK wpa2Psk Pass Phrase Encryption Type' },
    ]);
    const bySlot = new Map(matches.map((m) => [m.slotText, m.documentId]));
    expect(bySlot.get(slots[0]!.slotText)).toBe('diagram');
    expect(bySlot.get(slots[1]!.slotText)).toBe('panel');
  });

  it('never assigns one picture to two boxes', () => {
    const slots = [
      { node: {}, slotText: '[ TEMPELKAN SCREENSHOT: Diagram Topologi ]' } as never,
      { node: {}, slotText: '[ TEMPELKAN SCREENSHOT: Diagram Topologi Jaringan ]' } as never,
    ];
    const { matches } = matchFiguresToSlots(slots, [{ documentId: 'topology', text: TOPOLOGY_OCR }]);
    expect(matches).toHaveLength(1);
  });
});

describe('filling screenshot slots in the document', () => {
  it('puts the picture inside the dashed box and removes the instruction', () => {
    const result = assembleDocx(slotTemplate(), {
      sections: [
        {
          sectionId: 'sec-topology',
          headingText: '2.1 Topologi Jaringan',
          paragraphIndex: 1,
          insertionStrategy: 'after_heading',
          content: 'Topologi terdiri atas dua router dan satu switch.',
          figures: [
            {
              bytes: tinyPng(),
              extension: 'png',
              documentId: 'img-topology',
              text: TOPOLOGY_OCR,
              caption: 'Sumber: 1.png',
            },
          ],
        },
      ],
    });

    const xml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    const [root] = parseXml(xml);
    const body = findChild(root!, 'w:body')!;
    const tables = findAll(body, 'w:tbl');
    // The topology box is the first table in the document.
    const box = tables[0]!;

    // The picture must be INSIDE the box…
    const drawingsInBox = findAll(box, 'w:drawing');
    expect(drawingsInBox).toHaveLength(1);

    // …and the instruction that used to fill the box must be gone from it.
    const boxText = collectText(box);
    expect(boxText).not.toMatch(/TEMPELKAN/i);

    // The caption below the box is untouched: the reader now sees picture then caption.
    const captionIndex = body.children.findIndex((n) => collectText(n).includes('Gambar 1. Arsitektur'));
    const boxIndex = body.children.indexOf(box);
    expect(captionIndex).toBeGreaterThan(boxIndex);
    expect(collectText(body)).toContain('Gambar 1. Arsitektur');
  });

  it('fills each box with the screenshot that matches its instruction', () => {
    const result = assembleDocx(slotTemplate(), {
      sections: [
        {
          sectionId: 'sec-topology',
          headingText: '2.1 Topologi Jaringan',
          paragraphIndex: 1,
          insertionStrategy: 'after_heading',
          content: 'Topologi dua router.',
          figures: [
            { bytes: tinyPng(), extension: 'png', documentId: 'img-topology', text: TOPOLOGY_OCR },
            { bytes: tinyPng(), extension: 'png', documentId: 'img-ospf', text: OSPF_OCR },
          ],
        },
      ],
    });

    const xml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    const [root] = parseXml(xml);
    const body = findChild(root!, 'w:body')!;
    const tables = findAll(body, 'w:tbl');
    expect(tables).toHaveLength(2);
    // Both boxes filled, no instructions left, no figure appended outside the boxes.
    expect(findAll(tables[0]!, 'w:drawing')).toHaveLength(1);
    expect(findAll(tables[1]!, 'w:drawing')).toHaveLength(1);
    expect(collectText(body)).not.toMatch(/TEMPELKAN/i);
    // Exactly two pictures in total: none was appended as a stray.
    expect(findAll(body, 'w:drawing')).toHaveLength(2);
  });

  it('leaves a figure outside the boxes when no box claims it', () => {
    const result = assembleDocx(slotTemplate(), {
      sections: [
        {
          sectionId: 'sec-topology',
          headingText: '2.1 Topologi Jaringan',
          paragraphIndex: 1,
          insertionStrategy: 'after_heading',
          content: 'Topologi.',
          figures: [
            { bytes: tinyPng(), extension: 'png', documentId: 'img-ospf', text: OSPF_OCR },
          ],
        },
      ],
    });
    const xml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    const [root] = parseXml(xml);
    const body = findChild(root!, 'w:body')!;
    const boxes = findAll(body, 'w:tbl');
    // No box matches an OSPF capture inside the topology section at that position,
    // so nothing is stuffed into the wrong box…
    expect(findAll(boxes[0]!, 'w:drawing')).toHaveLength(0);
    // …and the picture still reaches the document rather than being lost.
    expect(findAll(body, 'w:drawing')).toHaveLength(1);
  });

  it('sizes the picture to the box so it cannot overflow the frame', () => {
    const result = assembleDocx(slotTemplate(), {
      sections: [
        {
          sectionId: 'sec-topology',
          headingText: '2.1 Topologi Jaringan',
          paragraphIndex: 1,
          insertionStrategy: 'after_heading',
          content: 'Topologi.',
          figures: [{ bytes: tinyPng(), extension: 'png', documentId: 'img-topology', text: TOPOLOGY_OCR }],
        },
      ],
    });
    const xml = xmlToString(readDocxPackage(result.buffer).files['word/document.xml']!);
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
    expect(extent).not.toBeNull();
    const cx = Number(extent![1]);
    // The template's box is 8504 twips wide; the picture must fit inside it.
    expect(cx).toBeLessThanOrEqual((8504 - 400) * 635);
    expect(cx).toBeGreaterThan(0);
  });
});

/** Concatenated text of a node, used to assert what a box now says. */
function collectText(node: XmlNode): string {
  if (node.tag === '#text') return node.text ?? '';
  let out = '';
  for (const child of node.children) out += collectText(child);
  return out;
}
