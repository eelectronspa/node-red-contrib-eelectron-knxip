import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GroupAddress, IndividualAddress } from '../../src/core/address';
import { groupValueRead, groupValueWrite, smallValue } from '../../src/core/apci';
import {
  CEMIFlags,
  CEMIFrame,
  CEMILData,
  CEMIMessageCode,
  DEFAULT_OUTGOING_FLAGS,
} from '../../src/core/cemi';
import { CouldNotParseCEMI, ConversionError } from '../../src/core/errors';
import { tConnect, tDataGroup, tDataIndividual } from '../../src/core/tpci';

describe('CEMILData', () => {
  it('serializes a GroupValueRead L_DATA_REQ', () => {
    const data = new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.5'),
      dstAddr: new GroupAddress('1/2/3'),
      tpci: tDataGroup(),
      payload: groupValueRead(),
    });
    const buf = data.toKnx();
    // 7 fixed + 2 APDU
    assert.equal(buf.length, 9);
    // last 2 bytes are APDU = [0x00, 0x00] (GROUP_READ)
    assert.equal(buf[7], 0x00);
    assert.equal(buf[8], 0x00);
    // npdu length = 1 for GROUP_READ
    assert.equal(buf[6], 0x01);
  });

  it('serializes a GroupValueWrite small=1 (1-bit boolean true)', () => {
    const data = new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.5'),
      dstAddr: new GroupAddress('1/2/3'),
      tpci: tDataGroup(),
      payload: groupValueWrite(smallValue(1)),
    });
    const buf = data.toKnx();
    assert.equal(buf.length, 9);
    assert.equal(buf[6], 0x01); // npdu length
    assert.equal(buf[7], 0x00); // TPCI=0 + APCI high bits=0
    assert.equal(buf[8], 0x81); // GROUP_WRITE | 1
  });

  it('round-trips a GroupValueWrite small over the bus', () => {
    const original = new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.10'),
      dstAddr: new GroupAddress('5/3/7'),
      tpci: tDataGroup(),
      payload: groupValueWrite(smallValue(42)),
    });
    const buf = original.toKnx();
    const { data: parsed, bytesRead } = CEMILData.fromKnx(buf);
    assert.equal(bytesRead, buf.length);
    assert.equal(parsed.flags, original.flags);
    assert.equal(parsed.srcAddr.toString(), '1.1.10');
    assert.ok(parsed.dstAddr instanceof GroupAddress);
    assert.equal((parsed.dstAddr as GroupAddress).raw, original.dstAddr.raw);
    assert.deepEqual(parsed.tpci, { kind: 'TDataGroup' });
    assert.deepEqual(parsed.payload, {
      kind: 'GroupValueWrite',
      data: { kind: 'small', value: 42 },
    });
  });

  it('round-trips a GroupValueWrite bytes (2-byte payload)', () => {
    const original = new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.10'),
      dstAddr: new GroupAddress('5/3/7'),
      tpci: tDataGroup(),
      payload: groupValueWrite({ kind: 'bytes', value: Buffer.from([0xab, 0xcd]) }),
    });
    const buf = original.toKnx();
    assert.equal(buf[6], 0x03); // NPDU length = APDU length - 1 = 4 - 1 = 3
    const { data: parsed } = CEMILData.fromKnx(buf);
    assert.deepEqual(parsed.payload, {
      kind: 'GroupValueWrite',
      data: { kind: 'bytes', value: Buffer.from([0xab, 0xcd]) },
    });
  });

  it('rejects control TPDU with payload at serialize time', () => {
    const bad = new CEMILData({
      flags: DEFAULT_OUTGOING_FLAGS,
      srcAddr: new IndividualAddress('1.1.1'),
      dstAddr: new IndividualAddress('1.1.2'),
      tpci: tConnect(),
      payload: groupValueRead(),
    });
    assert.throws(() => bad.toKnx(), ConversionError);
  });

  it('rejects data TPDU without payload', () => {
    const bad = new CEMILData({
      flags: DEFAULT_OUTGOING_FLAGS,
      srcAddr: new IndividualAddress('1.1.1'),
      dstAddr: new IndividualAddress('1.1.2'),
      tpci: tDataIndividual(),
      payload: null,
    });
    assert.throws(() => bad.toKnx(), ConversionError);
  });

  it('rejects too-short buffer at parse', () => {
    assert.throws(() => CEMILData.fromKnx(Buffer.alloc(5)), CouldNotParseCEMI);
  });

  it('detects mismatched NPDU length', () => {
    // Build a frame with NPDU length 5 but only 2 APDU bytes available
    const buf = Buffer.from([
      0xbc, 0x00, // flags
      0x11, 0x05, // src
      0x09, 0x03, // dst (group)
      0x05, // npdu length (claims 5)
      0x00, 0x80, // APDU only 2 bytes
    ]);
    assert.throws(() => CEMILData.fromKnx(buf), CouldNotParseCEMI);
  });

  it('hops getter/setter', () => {
    const data = new CEMILData({
      flags: 0x0060, // hop count 6
      srcAddr: new IndividualAddress(0),
      dstAddr: new GroupAddress(0),
      tpci: tDataGroup(),
      payload: groupValueRead(),
    });
    assert.equal(data.hops, 6);
    data.hops = 3;
    assert.equal(data.hops, 3);
    assert.equal(data.flags & 0x0070, 0x0030);
  });
});

describe('CEMIFrame', () => {
  it('round-trips a full L_DATA_IND frame', () => {
    const ld = new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.42'),
      dstAddr: new GroupAddress('2/4/8'),
      tpci: tDataGroup(),
      payload: groupValueWrite(smallValue(1)),
    });
    const original = new CEMIFrame({ code: CEMIMessageCode.L_DATA_IND, data: ld });
    const buf = original.toKnx();

    // [0]=code, [1]=info length=0, then 9 bytes of L_Data
    assert.equal(buf[0], 0x29);
    assert.equal(buf[1], 0x00);
    assert.equal(buf.length, 11);

    const { frame: parsed } = CEMIFrame.fromKnx(buf);
    assert.equal(parsed.code, CEMIMessageCode.L_DATA_IND);
    assert.equal(parsed.additionalInfo.length, 0);
    assert.deepEqual(parsed.data.payload, {
      kind: 'GroupValueWrite',
      data: { kind: 'small', value: 1 },
    });
  });

  it('handles non-empty additional info', () => {
    const ld = new CEMILData({
      flags: DEFAULT_OUTGOING_FLAGS | CEMIFlags.DESTINATION_GROUP_ADDRESS,
      srcAddr: new IndividualAddress(0),
      dstAddr: new GroupAddress(0x0901),
      tpci: tDataGroup(),
      payload: groupValueRead(),
    });
    const original = new CEMIFrame({
      code: CEMIMessageCode.L_DATA_REQ,
      additionalInfo: Buffer.from([0x03, 0x01, 0x02, 0x03]),
      data: ld,
    });
    const buf = original.toKnx();
    assert.equal(buf[0], 0x11);
    assert.equal(buf[1], 4);
    const { frame: parsed } = CEMIFrame.fromKnx(buf);
    assert.deepEqual(Array.from(parsed.additionalInfo), [0x03, 0x01, 0x02, 0x03]);
  });

  it('rejects unknown CEMI message codes', () => {
    const buf = Buffer.from([0xfc, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    assert.throws(() => CEMIFrame.fromKnx(buf), CouldNotParseCEMI);
  });
});
