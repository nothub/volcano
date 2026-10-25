import { runWorkflow } from './workflow.js';
import { decodeTemp, encodeTarget, hexBytes, statusFlags } from './volcano.js';

function assertEquals(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}\n     got ${a}`);
}

// Reaches each target instantly unless `reachTargets` is false.
function fakeVolcano({ reachTargets = true } = {}) {
  return {
    temp: 20,
    log: [],
    setTarget(c) {
      this.log.push(['target', c]);
      if (reachTargets) this.temp = c;
      return Promise.resolve();
    },
    heat(on) {
      this.log.push(['heat', on]);
      return Promise.resolve();
    },
    air(on) {
      this.log.push(['air', on]);
      return Promise.resolve();
    },
  };
}

Deno.test('runs steps in order and switches everything off at the end', async () => {
  const v = fakeVolcano();
  await runWorkflow(v, { steps: [{ temp: 180, hold: 0, air: 0.01 }, { temp: 190, hold: 0, air: 0.01 }] });
  assertEquals(v.log, [
    ['target', 180], ['heat', true], ['air', true], ['air', false],
    ['target', 190], ['air', true], ['air', false],
    ['air', false], ['heat', false],
  ]);
});

Deno.test('waits for the target temperature before pumping', async () => {
  const v = fakeVolcano({ reachTargets: false });
  const run = runWorkflow(v, { steps: [{ temp: 200, hold: 0, air: 0.01 }] });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(v.log, [['target', 200], ['heat', true]]);
  v.temp = 199; // inside the 1 °C margin
  await run;
  assertEquals(v.log.slice(2, 4), [['air', true], ['air', false]]);
});

Deno.test('air 0 skips the pump', async () => {
  const v = fakeVolcano();
  await runWorkflow(v, { steps: [{ temp: 180, hold: 0, air: 0 }] });
  assertEquals(v.log, [['target', 180], ['heat', true], ['air', false], ['heat', false]]);
});

Deno.test('abort during air stops pump and heater', async () => {
  const v = fakeVolcano();
  const ctrl = new AbortController();
  const run = runWorkflow(v, { steps: [{ temp: 180, hold: 0, air: 60 }] }, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 20));
  ctrl.abort();
  let error;
  await run.catch((e) => { error = e; });
  assertEquals(error?.name, 'AbortError');
  assertEquals(v.log.slice(-2), [['air', false], ['heat', false]]);
});

Deno.test('temperature encoding is tenths of °C, little-endian', () => {
  assertEquals([...new Uint8Array(encodeTarget(185))], [0x3a, 0x07, 0, 0]);
  assertEquals(decodeTemp(new DataView(new Uint8Array([0x3a, 0x07]).buffer)), 185);
});

Deno.test('status register flags', () => {
  assertEquals(statusFlags(1, 0x2020), ['heat', 'pump']);
  assertEquals(statusFlags(1, 0x0008), ['error']);
  assertEquals(statusFlags(2, 0x1200), ['fahrenheit', 'display off while cooling']);
  assertEquals(statusFlags(3, 0), []);
});

Deno.test('hexBytes respects the view window', () => {
  const buf = new Uint8Array([0xff, 0x0a, 0xb0, 0x01]).buffer;
  assertEquals(hexBytes(new DataView(buf, 1, 2)), '0a b0');
  assertEquals(hexBytes(buf), 'ff 0a b0 01');
});
