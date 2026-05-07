import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { interpolateString, renderJsonTemplate } from '../../src/util/template';

describe('interpolateString', () => {
  it('replaces a single placeholder', () => {
    assert.equal(interpolateString('knx/{ga}', { ga: '1/2/3' }), 'knx/1/2/3');
  });

  it('replaces several placeholders', () => {
    assert.equal(
      interpolateString('home/{dpt}/{ga}', { ga: '1/2/3', dpt: '1.001' }),
      'home/1.001/1/2/3',
    );
  });

  it('leaves unknown placeholders literal', () => {
    assert.equal(interpolateString('a {unknown} b', {}), 'a {unknown} b');
  });

  it('stringifies non-string values', () => {
    assert.equal(interpolateString('{n}', { n: 42 }), '42');
    assert.equal(interpolateString('{b}', { b: true }), 'true');
    assert.equal(interpolateString('{o}', { o: { x: 1 } }), '{"x":1}');
  });

  it('null / undefined render as empty string', () => {
    assert.equal(interpolateString('a:{x},b:{y}', { x: null, y: undefined }), 'a:,b:');
  });
});

describe('renderJsonTemplate — typed pure-placeholder', () => {
  it('preserves number type', () => {
    const r = renderJsonTemplate('{"v": "{value}"}', { value: 42 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { v: 42 });
  });

  it('preserves boolean type', () => {
    const r = renderJsonTemplate('{"v": "{value}"}', { value: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { v: true });
  });

  it('preserves object type', () => {
    const r = renderJsonTemplate('{"v": "{value}"}', { value: { r: 1, g: 2 } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { v: { r: 1, g: 2 } });
  });

  it('keeps strings with embedded placeholders interpolated', () => {
    const r = renderJsonTemplate('{"name": "hello {gaName}!"}', { gaName: 'lights' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { name: 'hello lights!' });
  });

  it('walks nested objects + arrays', () => {
    const r = renderJsonTemplate(
      '{"a": [{"v": "{value}"}, "static"]}',
      { value: 5 },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { a: [{ v: 5 }, 'static'] });
  });

  it('returns parse error on malformed JSON', () => {
    const r = renderJsonTemplate('{not: valid}', {});
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.indexOf('JSON template did not parse') !== -1);
  });

  it('unknown placeholder kept as literal string', () => {
    const r = renderJsonTemplate('{"x": "{nope}"}', {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { x: '{nope}' });
  });
});
