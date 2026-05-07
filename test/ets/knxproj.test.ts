import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import AdmZip from 'adm-zip';
import { parseKnxproj } from '../../src/ets/knxproj';
import { ETSProjectMap } from '../../src/ets/projectMap';

function buildSyntheticKnxproj(): Buffer {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KNX>
  <Project Id="P-0001">
    <ProjectInformation Name="Sample Project" />
    <Installations>
      <Installation Name="default">
        <GroupAddresses>
          <GroupRanges>
            <GroupRange Id="R1" RangeStart="0" RangeEnd="2047" Name="Lighting">
              <GroupRange Id="R1-1" RangeStart="0" RangeEnd="255" Name="Living">
                <GroupAddress Id="GA-1" Address="2049" Name="Ceiling On/Off" Description="Living room ceiling" DatapointType="DPST-1-1" />
                <GroupAddress Id="GA-2" Address="2050" Name="Ceiling Brightness" DatapointType="DPST-5-1" />
              </GroupRange>
            </GroupRange>
            <GroupRange Id="R2" RangeStart="2048" RangeEnd="4095" Name="Climate">
              <GroupAddress Id="GA-3" Address="4097" Name="Living Setpoint" DatapointType="DPST-9-1" />
              <GroupAddress Id="GA-4" Address="4098" Name="No DPT" />
            </GroupRange>
          </GroupRanges>
        </GroupAddresses>
      </Installation>
    </Installations>
  </Project>
</KNX>`;
  const zip = new AdmZip();
  zip.addFile('P-0001/0.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

describe('parseKnxproj (synthetic)', () => {
  const buf = buildSyntheticKnxproj();
  const result = parseKnxproj(buf);

  it('extracts the project name', () => {
    assert.equal(result.projectName, 'Sample Project');
  });

  it('parses every GroupAddress element it finds', () => {
    assert.equal(result.groupAddresses.length, 4);
  });

  it('converts raw addresses to long-form GA strings', () => {
    const byGa = new Map(result.groupAddresses.map((g) => [g.ga, g]));
    // 2049 = (1<<11) | 1 = main 1, middle 0, sub 1 → "1/0/1"
    assert.ok(byGa.has('1/0/1'));
    // 4097 = (2<<11) | 1 → "2/0/1"
    assert.ok(byGa.has('2/0/1'));
  });

  it('captures DPT, Name, and Description when present', () => {
    const ga = result.groupAddresses.find((g) => g.ga === '1/0/1');
    assert.ok(ga);
    assert.equal(ga!.dpt, 'DPST-1-1');
    assert.equal(ga!.name, 'Ceiling On/Off');
    assert.equal(ga!.description, 'Living room ceiling');
  });

  it('handles GAs without a DatapointType', () => {
    const ga = result.groupAddresses.find((g) => g.name === 'No DPT');
    assert.ok(ga);
    assert.equal(ga!.dpt, null);
  });
});

describe('ETSProjectMap.loadKnxproj (synthetic)', () => {
  const buf = buildSyntheticKnxproj();
  const map = new ETSProjectMap();
  const result = map.loadKnxproj(buf);

  it('records the entries in the map', () => {
    assert.equal(result.entries, 4);
  });

  it('normalises DPT ids and recognises codecs', () => {
    const entry = map.get('1/0/1');
    assert.ok(entry);
    assert.equal(entry!.dpt, '1.001'); // normalised + registered
    assert.equal(entry!.dptRaw, 'DPST-1-1');
  });

  it('counts only entries with a registered DPT', () => {
    assert.equal(result.withDpt, 3); // 1/0/1, 1/0/2 (5.001), 2/0/1 (9.001) — 2/0/2 has no DPT
  });

  it('exposes the project name from the archive', () => {
    assert.equal(result.projectName, 'Sample Project');
  });
});

describe('parseKnxproj rejects invalid inputs', () => {
  it('throws on a non-ZIP buffer', () => {
    assert.throws(
      () => parseKnxproj(Buffer.from('this is not a zip file')),
      /not a valid|Could not open/i,
    );
  });

  it('returns warning when archive has no XML files', () => {
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('hello', 'utf8'));
    const result = parseKnxproj(zip.toBuffer());
    assert.equal(result.groupAddresses.length, 0);
    assert.ok(result.warnings.some((w) => /No XML/i.test(w)));
  });
});
