import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  KnxprojBadPassword,
  KnxprojPasswordRequired,
  parseKnxproj,
} from '../../src/ets/knxproj';
import { ETSProjectMap } from '../../src/ets/projectMap';

// Live fixture — only runs locally when the user's encrypted ETS6 export is
// present in the project root. The file is gitignored (*.knxproj).
const FIXTURE_PATH = '/home/innovera/projects/software/eelectron-knxip/KNX Secure (1).knxproj';
const FIXTURE_PASSWORD = 'furious';
const SKIP = !existsSync(FIXTURE_PATH);

describe('parseKnxproj against an encrypted ETS6 export', () => {
  it('throws KnxprojPasswordRequired when no password is provided', { skip: SKIP }, () => {
    const buf = readFileSync(FIXTURE_PATH);
    assert.throws(() => parseKnxproj(buf), KnxprojPasswordRequired);
  });

  it('throws KnxprojBadPassword for the wrong password', { skip: SKIP }, () => {
    const buf = readFileSync(FIXTURE_PATH);
    assert.throws(
      () => parseKnxproj(buf, { password: 'this-is-not-the-password' }),
      KnxprojBadPassword,
    );
  });

  it('parses successfully with the correct password', { skip: SKIP }, () => {
    const buf = readFileSync(FIXTURE_PATH);
    const result = parseKnxproj(buf, { password: FIXTURE_PASSWORD });
    assert.ok(result.groupAddresses.length > 0, 'expected at least one GA');
    // Every GA in this fixture carries a DPT.
    const withDpt = result.groupAddresses.filter((g) => g.dpt).length;
    assert.equal(withDpt, result.groupAddresses.length);
    // Project name comes from the inner archive's project XML.
    assert.ok(result.projectName, 'expected projectName to be set');
  });

  it('integrates with ETSProjectMap.loadKnxproj + DPT normalisation', { skip: SKIP }, () => {
    const buf = readFileSync(FIXTURE_PATH);
    const map = new ETSProjectMap();
    const result = map.loadKnxproj(buf, { password: FIXTURE_PASSWORD });
    assert.ok(result.entries > 0);
    // First entry's DPT should normalise (e.g. DPST-1-1 → 1.001).
    const sample = map.list().find((e) => e.dptRaw && e.dptRaw.startsWith('DPST-'));
    assert.ok(sample, 'expected at least one entry with a DPST-* DPT');
    assert.match(sample!.dpt ?? '', /^\d+\.\d+$/, 'expected normalised dotted DPT id');
  });
});
