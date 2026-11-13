/**
 * A table must grow only from entities the evidence names.
 *
 * Allowing the writer to compute was correct, but the first attempt went further
 * than allowed: asked to tabulate the subnets, it produced a `/27` block and a
 * `/25` remainder that appear nowhere in the source — while the arithmetic inside
 * each row was flawless. Correct numbers about invented entities are still
 * fabrication, and a table reads as more authoritative than prose, so this is the
 * check that keeps "complete" from meaning "made up".
 */
import { describe, expect, it } from 'vitest';
import { untraceableTableRows, fullyUnfilledTableRows } from '../src/services/generation/source-fidelity.js';

// The real evidence behind section 2.2: two subnets, and .97 only as a next hop.
const EVIDENCE = [
  '192.168.10.0/26 [110/2] via 192.168.10.97, 00:01:14, GigabitEthernet0/0',
  '192.168.10.64/27 is directly connected, GigabitEthernet0/1',
  '192.168.10.65/32 is directly connected, GigabitEthernet0/1',
].join('\n');

const COLUMNS = ['Alamat / Blok', 'Peran', 'Mask', 'Network', 'Broadcast', 'Jumlah Host'];

describe('untraceableTableRows', () => {
  it('accepts rows whose subnet the evidence actually shows', () => {
    const table = {
      columns: COLUMNS,
      rows: [
        ['192.168.10.0/26', 'serverPool', '255.255.255.192', '192.168.10.0 (dihitung)', '192.168.10.63', '62'],
        ['192.168.10.64/27', 'LAN-WIFI', '255.255.255.224', '192.168.10.64 (dihitung)', '192.168.10.95', '30'],
      ],
    };
    expect(untraceableTableRows(table, EVIDENCE)).toEqual([]);
  });

  it('catches the invented blocks that shipped in the real report', () => {
    const table = {
      columns: COLUMNS,
      rows: [
        ['192.168.10.0/26', 'serverPool', '255.255.255.192'],
        ['192.168.10.64/27', 'LAN-WIFI', '255.255.255.224'],
        // Neither of these appears in the evidence.
        ['192.168.10.96/27', 'gateway of last resort', '255.255.255.224'],
        ['192.168.10.128/25', 'blok sisa', '255.255.255.128'],
      ],
    };
    const flagged = untraceableTableRows(table, EVIDENCE);
    expect(flagged).toHaveLength(2);
    expect(flagged.join(' ')).toContain('192.168.10.96/27');
    expect(flagged.join(' ')).toContain('192.168.10.128/25');
  });

  it('does not blame a computed cell for its own row', () => {
    // The broadcast and host count are new numbers, but the row names a real subnet.
    const table = {
      columns: COLUMNS,
      rows: [['192.168.10.0/26', '(dihitung)', '192.168.10.63 (dihitung)', '62 (dihitung)']],
    };
    expect(untraceableTableRows(table, EVIDENCE)).toEqual([]);
  });

  it('tolerates a row identified by a device name from the evidence', () => {
    const table = {
      columns: ['Perangkat', 'Prompt', 'Status'],
      rows: [
        ['R-KABEL', 'R-KABEL>', 'up'],
        ['Switch0', 'n/a', 'up'],
      ],
    };
    expect(untraceableTableRows(table, 'R-KABEL>show ip route\nSwitch0 Fa0/1 up')).toEqual([]);
  });

  it('reports nothing when there is no table at all', () => {
    expect(untraceableTableRows(null, EVIDENCE)).toEqual([]);
    expect(untraceableTableRows(undefined, EVIDENCE)).toEqual([]);
    expect(untraceableTableRows({ columns: COLUMNS, rows: [] }, EVIDENCE)).toEqual([]);
  });
});

describe('fullyUnfilledTableRows', () => {
  const COLUMNS = ['Subnet / Perangkat', 'Blok Jaringan', 'Prefix', 'Gateway'];

  it('catches a row that was abandoned instead of filled', () => {
    // The real defect: the `show ip interface brief` screenshot clearly shows
    // 192.168.10.97, yet the whole R-KABEL row came back as markers.
    const table = {
      columns: COLUMNS,
      rows: [
        ['serverPool', '192.168.10.0', '/26', '192.168.10.1'],
        [
          'R-KABEL (antarmuka)',
          '[PERLU DICEK: alamat IP antarmuka R-KABEL]',
          '[PERLU DICEK: prefix antarmuka R-KABEL]',
          '[PERLU DICEK: gateway antarmuka R-KABEL]',
        ],
      ],
    };
    expect(fullyUnfilledTableRows(table)).toEqual(['R-KABEL (antarmuka)']);
  });

  it('accepts a row that fills what it can and flags only the rest', () => {
    const table = {
      columns: COLUMNS,
      rows: [['R-KABEL (antarmuka)', '192.168.10.97', '[PERLU DICEK: prefix]', '[PERLU DICEK: gateway]']],
    };
    expect(fullyUnfilledTableRows(table)).toEqual([]);
  });

  it('ignores blank cells in an otherwise filled row', () => {
    expect(fullyUnfilledTableRows({ columns: COLUMNS, rows: [['serverPool', '192.168.10.0', '', '']] })).toEqual([]);
  });

  it('handles a missing table', () => {
    expect(fullyUnfilledTableRows(null)).toEqual([]);
    expect(fullyUnfilledTableRows(undefined)).toEqual([]);
  });
});
