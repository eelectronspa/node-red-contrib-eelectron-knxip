import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseEtsCsv } from '../../src/ets/csvParser';

describe('parseEtsCsv', () => {
  it('parses a typical ETS6 English export with comma delimiter', () => {
    const csv = [
      '"Main","Middle","Sub","Address","DatapointType","Description"',
      '"Lighting","Living","Ceiling On/Off","1/2/3","DPST-1-1","Living room ceiling"',
      '"Lighting","Living","Ceiling Brightness","1/2/4","DPST-5-1","Living room dim level"',
    ].join('\n');
    const { rows, warnings } = parseEtsCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.ga, '1/2/3');
    assert.equal(rows[0]!.dpt, 'DPST-1-1');
    assert.equal(rows[0]!.description, 'Living room ceiling');
    assert.equal(warnings.length, 0);
  });

  it('handles semicolon delimiter (German locale exports)', () => {
    const csv = [
      'Adresse;Datapunkttyp;Beschreibung',
      '1/2/3;DPST-1-1;Wohnzimmer Decke',
    ].join('\n');
    const { rows } = parseEtsCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ga, '1/2/3');
    assert.equal(rows[0]!.dpt, 'DPST-1-1');
  });

  it('handles BOM and Windows line endings', () => {
    const csv = '﻿Address,DPT\r\n1/2/3,1.001\r\n';
    const { rows } = parseEtsCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.ga, '1/2/3');
  });

  it('handles quoted fields with embedded commas', () => {
    const csv = ['Address,Description', '"1/2/3","ceiling, on/off"'].join('\n');
    const { rows } = parseEtsCsv(csv);
    assert.equal(rows[0]!.description, 'ceiling, on/off');
  });

  it('positional fallback when no header is recognised', () => {
    const csv = ['1/2/3,DPST-1-1,kitchen', '1/2/4,DPST-5-1,kitchen-dim'].join('\n');
    const { rows } = parseEtsCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.ga, '1/2/3');
    assert.equal(rows[0]!.dpt, 'DPST-1-1');
  });

  it('skips rows whose GA does not parse', () => {
    const csv = ['Address,DPT', '1/2/3,1.001', 'garbage,1.001'].join('\n');
    const { rows, warnings } = parseEtsCsv(csv);
    assert.equal(rows.length, 1);
    assert.ok(warnings.some((w) => w.includes('garbage')));
  });

  it('returns warning for empty input', () => {
    const { rows, warnings } = parseEtsCsv('');
    assert.equal(rows.length, 0);
    assert.ok(warnings.length > 0);
  });
});
