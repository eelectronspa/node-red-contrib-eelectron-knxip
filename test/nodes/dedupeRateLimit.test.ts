// Unit tests for the standalone dedupe + rate-limit nodes. We don't pull in
// `node-red-node-test-helper` (heavy dep) — instead we drive the nodes
// directly with a hand-rolled mock that captures sent messages, since the
// nodes only consume `RED.nodes.createNode`, `RED.nodes.registerType`, and
// the standard `on('input' | 'close')` event surface.

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, it, mock } from 'node:test';

interface MockNode extends EventEmitter {
  status: ReturnType<typeof mock.fn>;
  sent: Array<unknown>;
  send: (m: unknown) => void;
}

function makeNode(): MockNode {
  const node = new EventEmitter() as MockNode;
  node.status = mock.fn();
  node.sent = [];
  node.send = (m: unknown) => {
    node.sent.push(m);
  };
  return node;
}

interface MockRED {
  nodes: {
    createNode: (n: unknown, _def: unknown) => void;
    registerType: (id: string, ctor: (def: unknown) => void) => void;
  };
  capturedCtor?: (def: unknown) => void;
}

function makeRED(): MockRED {
  const RED: MockRED = {
    nodes: {
      createNode: () => {
        /* no-op — we already constructed the node */
      },
      registerType: (_id, ctor) => {
        RED.capturedCtor = ctor;
      },
    },
  };
  return RED;
}

function loadNode(modulePath: string): {
  build: (def: unknown) => MockNode;
} {
  // Each call clears require cache so registerType's captured ctor is
  // freshly bound.
  const RED = makeRED();
  delete require.cache[require.resolve(modulePath)];
  // The node module returns a `(RED) => void` — invoke it to register.
  const factory = require(modulePath) as (red: unknown) => void;
  factory(RED);
  if (!RED.capturedCtor) throw new Error('node did not register a ctor');
  const ctor = RED.capturedCtor;
  return {
    build(def: unknown): MockNode {
      const node = makeNode();
      // Call the constructor with `this` bound to the node + the def.
      ctor.call(node, def);
      return node;
    },
  };
}

function fire(node: MockNode, msg: unknown): unknown[] {
  node.sent = [];
  // Node-RED gives input handlers (msg, send, done) — our test fires only
  // the listeners registered for 'input', and we pass our own done shim.
  let doneCalled = false;
  node.emit(
    'input',
    msg,
    (m: unknown) => {
      node.sent.push(m);
    },
    () => {
      doneCalled = true;
    },
  );
  void doneCalled;
  return node.sent;
}

describe('eelectron-knxip-dedupe', () => {
  const { build } = loadNode('../../src/nodes/dedupe/dedupe');

  it('drops identical (topic, payload) within the window', () => {
    const node = build({ id: 'd1', type: 'eelectron-knxip-dedupe', windowMs: 1000 });
    const a = fire(node, { topic: '1/1/1', payload: true });
    const b = fire(node, { topic: '1/1/1', payload: true });
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
  });

  it('passes a different payload immediately', () => {
    const node = build({ id: 'd1', type: 'eelectron-knxip-dedupe', windowMs: 60_000 });
    fire(node, { topic: '1/1/1', payload: 1 });
    const next = fire(node, { topic: '1/1/1', payload: 2 });
    assert.equal(next.length, 1);
  });

  it('treats different topics independently', () => {
    const node = build({ id: 'd1', type: 'eelectron-knxip-dedupe', windowMs: 60_000 });
    fire(node, { topic: '1/1/1', payload: true });
    const other = fire(node, { topic: '1/1/2', payload: true });
    assert.equal(other.length, 1);
  });

  it('treats objects as equal regardless of key order', () => {
    const node = build({ id: 'd1', type: 'eelectron-knxip-dedupe', windowMs: 60_000 });
    fire(node, { topic: '1/1/1', payload: { hour: 12, minute: 0 } });
    const next = fire(node, { topic: '1/1/1', payload: { minute: 0, hour: 12 } });
    assert.equal(next.length, 0);
  });

  it('treats Buffers as equal byte-for-byte', () => {
    const node = build({ id: 'd1', type: 'eelectron-knxip-dedupe', windowMs: 60_000 });
    fire(node, { topic: '1/1/1', payload: Buffer.from([1, 2, 3]) });
    const next = fire(node, { topic: '1/1/1', payload: Buffer.from([1, 2, 3]) });
    assert.equal(next.length, 0);
  });

  it('ignores topics when perTopic=false (single global bucket)', () => {
    const node = build({
      id: 'd1',
      type: 'eelectron-knxip-dedupe',
      windowMs: 60_000,
      perTopic: false,
    });
    fire(node, { topic: '1/1/1', payload: 1 });
    const otherTopic = fire(node, { topic: '1/1/2', payload: 1 });
    assert.equal(otherTopic.length, 0, 'global bucket should suppress same payload on a different topic');
  });
});

describe('eelectron-knxip-rate-limit', () => {
  const { build } = loadNode('../../src/nodes/rate-limit/rateLimit');

  it('passes up to maxPerWindow, drops the rest', () => {
    const node = build({
      id: 'r1',
      type: 'eelectron-knxip-rate-limit',
      maxPerWindow: 3,
      windowMs: 60_000,
    });
    const a = fire(node, { topic: '1/1/1', payload: 1 });
    const b = fire(node, { topic: '1/1/1', payload: 2 });
    const c = fire(node, { topic: '1/1/1', payload: 3 });
    const d = fire(node, { topic: '1/1/1', payload: 4 });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(c.length, 1);
    assert.equal(d.length, 0, 'fourth message should be dropped');
  });

  it('separates buckets per topic by default', () => {
    const node = build({
      id: 'r1',
      type: 'eelectron-knxip-rate-limit',
      maxPerWindow: 1,
      windowMs: 60_000,
    });
    const a1 = fire(node, { topic: '1/1/1', payload: 1 });
    const a2 = fire(node, { topic: '1/1/1', payload: 2 });
    const b1 = fire(node, { topic: '1/1/2', payload: 1 });
    assert.equal(a1.length, 1);
    assert.equal(a2.length, 0);
    assert.equal(b1.length, 1, 'unrelated topic should not share the bucket');
  });

  it('exposeDropped routes drops to output 2', () => {
    const node = build({
      id: 'r1',
      type: 'eelectron-knxip-rate-limit',
      maxPerWindow: 1,
      windowMs: 60_000,
      exposeDropped: true,
    });
    const a = fire(node, { topic: '1/1/1', payload: 1 });
    const b = fire(node, { topic: '1/1/1', payload: 2 });
    // First emits as [msg, null], second as [null, msg].
    assert.deepEqual(a[0], [{ topic: '1/1/1', payload: 1 }, null]);
    assert.deepEqual(b[0], [null, { topic: '1/1/1', payload: 2 }]);
  });

  it('rejects invalid maxPerWindow gracefully (clamped to 1)', () => {
    const node = build({
      id: 'r1',
      type: 'eelectron-knxip-rate-limit',
      maxPerWindow: 0,
      windowMs: 60_000,
    });
    const a = fire(node, { topic: '1/1/1', payload: 1 });
    const b = fire(node, { topic: '1/1/1', payload: 2 });
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
  });
});
