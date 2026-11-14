import { describe, expect, it } from 'vitest';
import {
  applyDocumentGapResolutions,
  applyGapResolutions,
  buildGapResolutionPrompt,
  collectDocumentGaps,
  decideProposal,
  findGapMarkers,
  parseGapProposals,
  proposalsFromModel,
  type GapProposal,
} from '../src/services/generation/gaps.js';

/**
 * Filling `[PERLU DICEK]` markers is the most dangerous operation in the app: the
 * markers exist precisely because no value was available, so a helpful-sounding
 * model is exactly what turns an honest gap into a confident lie.
 *
 * These tests pin the guard rails, not the happy path: a text value that is not
 * literally in the evidence must be rejected, an image value must name an image
 * that was actually attached, and anything "uncertain" must be discarded.
 */
describe('finding gap markers', () => {
  it('finds both languages in document order', () => {
    const content =
      'Prefix /30 [PERLU DICEK: prefix length] and [MISSING: gateway] then [PERLU DICEK: versi].';
    const markers = findGapMarkers(content);
    expect(markers.map((marker) => marker.question)).toEqual([
      'prefix length',
      'gateway',
      'versi',
    ]);
    expect(markers.map((marker) => marker.id)).toEqual([0, 1, 2]);
  });

  it('returns nothing for finished content', () => {
    expect(findGapMarkers('Semua nilai sudah terisi (dihitung).')).toEqual([]);
  });

  it('does not match a marker that is merely mentioned in prose', () => {
    // A warning text that explains the marker format must not be treated as a gap.
    expect(findGapMarkers('Warnings may contain [PERLU DICEK] wording.')).toHaveLength(0);
  });
});

const evidence = 'IPv4 Address 192.168.10.97\nSubnet Mask 255.255.255.0\nPrefix: /24';

function proposal(overrides: Partial<GapProposal> = {}): GapProposal {
  return {
    id: 0,
    markerText: '[PERLU DICEK: alamat IP]',
    value: '192.168.10.97',
    basis: 'IPv4 Address 192.168.10.97',
    source: 'text',
    confidence: 'certain',
    ...overrides,
  };
}

describe('accepting a proposed value', () => {
  it('accepts a text value that is literally present', () => {
    const decision = decideProposal(proposal(), evidence, []);
    expect(decision.accepted).toBe(true);
  });

  it('rejects a text value the evidence does not contain', () => {
    // The classic failure: a plausible neighbour address invented to look complete.
    const decision = decideProposal(proposal({ value: '192.168.10.98' }), evidence, []);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('not-in-evidence');
  });

  it('rejects a derived value even when it is arithmetically plausible', () => {
    // Derivation is allowed while WRITING a section. Resolving a gap is different:
    // the marker says "nobody recorded this", so a computed answer would launder a
    // guess into a fact.
    const decision = decideProposal(
      proposal({ value: '192.168.10.255', basis: 'broadcast of the subnet' }),
      evidence,
      [],
    );
    expect(decision.accepted).toBe(false);
  });

  it('rejects an uncertain answer', () => {
    const decision = decideProposal(proposal({ confidence: 'uncertain' }), evidence, []);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('uncertain');
  });

  it('rejects an answer with no basis', () => {
    const decision = decideProposal(proposal({ basis: '   ' }), evidence, []);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('no-basis');
  });

  it('rejects an empty value', () => {
    const decision = decideProposal(proposal({ value: '  ' }), evidence, []);
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('empty-value');
  });

  /**
   * Found in a live run: `0.0.0.0` is literally in the captures (DHCP DNS server,
   * Windows gateway field of an unconfigured adapter), so containment accepted it
   * as a gateway. Filling a gateway cell with "nothing" is worse than a marker —
   * it looks verified and says the opposite of what the screenshot shows.
   */
  it('rejects a placeholder value even when the evidence contains it', () => {
    const decision = decideProposal(
      proposal({ value: '0.0.0.0', basis: 'Default Gateway row of the adapter' }),
      'Default Gateway . . . . . . . . . : 0.0.0.0',
      [],
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('placeholder-value');
  });

  it('rejects placeholder numbers from an image too', () => {
    const decision = decideProposal(
      proposal({
        value: '0.0.0.0',
        basis: 'read from the adapter dialog',
        source: 'image',
        documentName: '7.png',
      }),
      '0.0.0.0',
      ['7.png'],
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('placeholder-value');
  });

  it('accepts an image value only when it names an attached image', () => {
    const accepted = decideProposal(
      proposal({
        value: '8.2.1',
        basis: 'read from the title bar',
        source: 'image',
        documentName: 'packet-tracer.png',
      }),
      'Packet Tracer 8.2.1 (title bar)',
      ['packet-tracer.png'],
    );
    expect(accepted.accepted).toBe(true);

    const rejected = decideProposal(
      proposal({
        value: '8.2.1',
        basis: 'read from the title bar',
        source: 'image',
        documentName: 'some-other.png',
      }),
      '',
      ['packet-tracer.png'],
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe('unknown-document');
  });

  it('rejects an image value with no document name', () => {
    const decision = decideProposal(
      proposal({ source: 'image', documentName: undefined }),
      '',
      ['packet-tracer.png'],
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('unknown-document');
  });

  /**
   * Found by running the real stack: the model was shown `11.png` (whose OCR says
   * only "Reply from 192.168.10.10") and answered with
   * `bytes=32 time=6ms TTL=126 TTL=126`, inventing the byte count and copying the
   * TTL from a different screenshot. Naming an attached image is not the same as
   * having read it, so the text has to corroborate the claim.
   */
  it('rejects an image value the evidence text contradicts', () => {
    const decision = decideProposal(
      proposal({
        value: 'Reply from 192.168.10.10: bytes=32 time=6ms TTL=126',
        basis: 'visible in the capture',
        source: 'image',
        documentName: '11.png',
      }),
      'Reply from 192.168.10.10\nReply from 192.168.10.10',
      ['11.png'],
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('not-in-evidence');
  });

  it('accepts an image value its damaged OCR still contains', () => {
    // The capture was read at 300 dpi, so the OCR kept `l` where the pixels show a
    // capital `I`. Rejecting that would leave a marker on a value that is right.
    // Only glyphs that look alike are collapsed — the digits stay exact.
    const decision = decideProposal(
      proposal({
        value: 'TTL-128',
        basis: 'read from the terminal capture',
        source: 'image',
        documentName: '15.png',
      }),
      'Reply from 192.168.10.10 TTl-128',
      ['15.png'],
    );
    expect(decision.accepted).toBe(true);
  });

  it('does not let the lookalike rule accept a different digit', () => {
    // Only letters are normalised. A changed digit is a different value.
    const decision = decideProposal(
      proposal({
        value: 'Reply from 192.168.10.10: TTL=126',
        basis: 'read from the terminal capture',
        source: 'image',
        documentName: '15.png',
      }),
      'Reply from 192.168.10.10 TTL=128',
      ['15.png'],
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('not-in-evidence');
  });

  it('matches evidence regardless of spacing and case', () => {
    const decision = decideProposal(
      proposal({ value: '255.255.255.0', basis: 'Subnet Mask row' }),
      'Subnet   Mask   255.255.255.0',
      [],
    );
    expect(decision.accepted).toBe(true);
  });

  it('matches a value through a separator the OCR mangled', () => {
    // 8.png reads `192.168.10.96/30 is directly connected, GigabitEthernet0/0`; a
    // model may answer `/30` for the mask length. The separator is not the value,
    // but it still separates: the boundary rule keeps `96` from matching `960`.
    const decision = decideProposal(
      proposal({ value: '/30', basis: 'routing table line' }),
      '192.168.10.96/30 is directly connected, GigabitEthernet0/0',
      [],
    );
    expect(decision.accepted).toBe(true);
  });

  /**
   * The subtle one: without a boundary rule, `192.168.10.1` (a DHCP gateway) was
   * accepted as present because `192.168.10.10` contains it. That would put one
   * host's address in another row.
   */
  it('does not match a value that is only a prefix of a longer number', () => {
    const decision = decideProposal(
      proposal({ value: '192.168.10.1', basis: 'pool gateway' }),
      'Start IP Address 192.168.10.10',
      [],
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('not-in-evidence');
  });
});

describe('applying resolutions', () => {
  it('replaces every occurrence of an accepted marker', () => {
    const content = 'Alamat [PERLU DICEK: alamat IP] dan cadangan [PERLU DICEK: alamat IP].';
    const decisions = [
      { proposal: proposal(), accepted: true },
    ];
    const result = applyGapResolutions(content, decisions);
    expect(result.content).toBe('Alamat 192.168.10.97 dan cadangan 192.168.10.97.');
    expect(result.replaced).toBe(1);
  });

  it('leaves a rejected marker in place', () => {
    const content = 'Alamat [PERLU DICEK: alamat IP].';
    const result = applyGapResolutions(content, [
      { proposal: proposal({ value: '10.0.0.1' }), accepted: false, reason: 'not-in-evidence' },
    ]);
    expect(result.content).toBe(content);
    expect(result.replaced).toBe(0);
  });
});

describe('parsing the model answer', () => {
  it('reads a bare JSON object', () => {
    expect(parseGapProposals('{"resolved":[{"id":0,"value":"x"}]}')).toHaveLength(1);
  });

  it('reads JSON inside a fenced block with prose around it', () => {
    const text = 'Here is what I found:\n```json\n{"resolved":[{"id":1,"value":"y"}]}\n```\nHope that helps.';
    const parsed = parseGapProposals(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.value).toBe('y');
  });

  it('returns nothing instead of throwing on junk', () => {
    expect(parseGapProposals('I could not read the image.')).toEqual([]);
    expect(parseGapProposals('')).toEqual([]);
  });
});

describe('mapping proposals to markers', () => {
  const markers = findGapMarkers('[PERLU DICEK: alamat IP] [PERLU DICEK: prefix]');

  it('attaches the literal marker text', () => {
    const proposals = proposalsFromModel([{ id: 1, value: '/24', basis: 'Prefix: /24', confidence: 'certain' }], markers);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.markerText).toBe('[PERLU DICEK: prefix]');
  });

  it('drops an id that does not exist rather than clamping it', () => {
    // A model that invents id 99 is not answering the question that was asked;
    // mapping it onto a real marker would put an unrelated value in the report.
    const proposals = proposalsFromModel([{ id: 99, value: 'oops' }], markers);
    expect(proposals).toEqual([]);
  });

  it('defaults an unknown source to text and unknown confidence to uncertain', () => {
    const proposals = proposalsFromModel([{ id: 0, value: 'x', basis: 'y' }], markers);
    expect(proposals[0]!.source).toBe('text');
    expect(proposals[0]!.confidence).toBe('uncertain');
  });
});

describe('the prompt', () => {
  it('tells the model that leaving a marker is correct', () => {
    const prompt = buildGapResolutionPrompt({
      heading: '2.3 Alokasi IP',
      language: 'id',
      markers: findGapMarkers('[PERLU DICEK: prefix]'),
      evidenceText: 'data',
      attachedImages: ['topologi.png'],
    });
    expect(prompt).toMatch(/Omit the id entirely/);
    expect(prompt).toMatch(/Never infer, average, guess/);
    expect(prompt).toContain('topologi.png');
    expect(prompt).toContain('2.3 Alokasi IP');
  });

  it('says so plainly when no image is attached', () => {
    const prompt = buildGapResolutionPrompt({
      heading: 'H',
      language: 'id',
      markers: findGapMarkers('[PERLU DICEK: x]'),
      evidenceText: 'data',
      attachedImages: [],
    });
    expect(prompt).toMatch(/no images attached/);
  });
});

/**
 * Most gaps in a finished report live in tables, not prose: an addressing table
 * keeps one unverified mask per interface. Resolving only `content` left all of
 * them behind, so these tests pin the table path and its per-row semantics.
 */
describe('gaps in tables', () => {
  const table = {
    columns: ['Perangkat', 'Antarmuka', 'Subnet Mask'],
    rows: [
      ['R-KABEL', 'GigabitEthernet0/0', '[PERLU DICEK: mask]'],
      ['R-KABEL', 'GigabitEthernet0/1', '[PERLU DICEK: mask]'],
    ],
  };

  it('finds body and table markers with stable ids and locations', () => {
    const gaps = collectDocumentGaps('Body [PERLU DICEK: versi].', table);
    expect(gaps).toHaveLength(3);
    expect(gaps.map((gap) => gap.id)).toEqual([0, 1, 2]);
    expect(gaps[0]!.where).toBe('body text');
    expect(gaps[1]!.where).toContain('table row 1');
    expect(gaps[1]!.where).toContain('Subnet Mask');
    expect(gaps[2]!.where).toContain('table row 2');
    // The row is part of the context, so the model can tell the two masks apart.
    expect(gaps[1]!.context).toContain('GigabitEthernet0/0');
    expect(gaps[2]!.context).toContain('GigabitEthernet0/1');
  });

  it('applies a value to the row it was asked about, not to every identical marker', () => {
    // Both cells read `[PERLU DICEK: mask]`. Replacing by text would write one
    // interface's mask onto the other, which is exactly the kind of plausible
    // corruption this whole module exists to avoid.
    const result = applyDocumentGapResolutions(
      { content: '', table },
      [
        {
          proposal: {
            id: 0,
            markerText: '[PERLU DICEK: mask]',
            value: '255.255.255.224',
            basis: 'interface output',
            source: 'text',
            confidence: 'certain',
          },
          accepted: true,
        },
      ],
    );
    expect(result.replaced).toBe(1);
    expect(result.table!.rows[0]![2]).toBe('255.255.255.224');
    expect(result.table!.rows[1]![2]).toBe('[PERLU DICEK: mask]');
  });

  it('keeps the body replacement separate from a table replacement', () => {
    const result = applyDocumentGapResolutions(
      { content: 'Versi [PERLU DICEK: versi].', table: { columns: ['Mask'], rows: [['[PERLU DICEK: versi]']] } },
      [
        {
          proposal: {
            id: 0,
            markerText: '[PERLU DICEK: versi]',
            value: '8.2.1',
            basis: 'title bar',
            source: 'text',
            confidence: 'certain',
          },
          accepted: true,
        },
      ],
    );
    expect(result.content).toBe('Versi 8.2.1.');
    expect(result.table!.rows[0]![0]).toBe('[PERLU DICEK: versi]');
    expect(result.replaced).toBe(1);
  });

  it('numbers attached images so an image-sourced value can name the right file', () => {
    const prompt = buildGapResolutionPrompt({
      heading: 'H',
      language: 'id',
      markers: collectDocumentGaps('', table),
      evidenceText: '',
      attachedImages: ['topologi.png', 'cli.png'],
    });
    expect(prompt).toContain('IMAGE 1: topologi.png');
    expect(prompt).toContain('IMAGE 2: cli.png');
    expect(prompt).toContain('location: table row 1');
  });
});
