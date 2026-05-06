import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GroupAddress } from '../../src/core/address';
import { smallValue } from '../../src/core/apci';
import {
  defaultTpci,
  telegramFromGroupRead,
  telegramFromGroupResponse,
  telegramFromGroupWrite,
} from '../../src/core/telegram';

describe('telegramFromGroupWrite', () => {
  it('builds an outgoing GroupValueWrite with auto TPCI', () => {
    const t = telegramFromGroupWrite('1/2/3', smallValue(1));
    assert.equal(t.direction, 'outgoing');
    assert.deepEqual(t.tpci, { kind: 'TDataGroup' });
    assert.deepEqual(t.payload, {
      kind: 'GroupValueWrite',
      data: { kind: 'small', value: 1 },
    });
    assert.equal(t.sourceAddress.raw, 0);
    assert.equal(t.destinationAddress.toString(), '1/2/3');
  });

  it('uses TDataBroadcast when destination is 0', () => {
    const t = telegramFromGroupWrite(0, smallValue(0));
    assert.deepEqual(t.tpci, { kind: 'TDataBroadcast' });
  });

  it('honors source override', () => {
    const t = telegramFromGroupWrite('1/2/3', smallValue(1), { source: '1.1.10' });
    assert.equal(t.sourceAddress.toString(), '1.1.10');
  });
});

describe('telegramFromGroupRead', () => {
  it('builds a GroupValueRead', () => {
    const t = telegramFromGroupRead('1/2/3');
    assert.deepEqual(t.payload, { kind: 'GroupValueRead' });
  });
});

describe('telegramFromGroupResponse', () => {
  it('builds a GroupValueResponse', () => {
    const t = telegramFromGroupResponse('1/2/3', smallValue(2));
    assert.deepEqual(t.payload, {
      kind: 'GroupValueResponse',
      data: { kind: 'small', value: 2 },
    });
  });
});

describe('defaultTpci', () => {
  it('selects broadcast when address is zero', () => {
    assert.deepEqual(defaultTpci(new GroupAddress(0)), { kind: 'TDataBroadcast' });
  });
});
