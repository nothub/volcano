import { MAX_TEMP, MIN_TEMP, statusFlags, Volcano } from './volcano.js';
import { DEFAULT_WORKFLOWS, runWorkflow } from './workflow.js';

const STORAGE_KEY = 'workflows';
const LOG_LIMIT = 10000;
const PHASE_LABEL = { heating: 'heating to', holding: 'holding', air: 'air at' };

const $ = (sel) => document.querySelector(sel);
const volcano = new Volcano();
const workflows = load();
let running = null;
let lastRun = null;
let editing = -1;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? structuredClone(DEFAULT_WORKFLOWS);
  } catch {
    return structuredClone(DEFAULT_WORKFLOWS);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows));
}

// Newest entry first, so no scroll handling is needed.
function log(text) {
  const now = new Date();
  const entry = document.createElement('li');
  entry.textContent = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')} ${text}`;
  $('#log').prepend(entry);
  $('#log').children[LOG_LIMIT]?.remove();
}

function setStatus(text) {
  $('#status').textContent = text;
}

function renderDevice() {
  const on = volcano.ready;
  $('#connect').textContent = volcano.connected ? 'Disconnect' : 'Connect';
  $('#device').disabled = !on;
  $('#status').hidden = on;
  $('#temp').hidden = !on;
  $('#temp').textContent = volcano.temp === null ? '--' : `${Math.round(volcano.temp)} °C`;
  // Leave the field alone while the user is typing in it.
  if (document.activeElement !== targetInput) targetInput.value = on ? Math.round(volcano.target) : '';
  $('#heat').setAttribute('aria-pressed', volcano.heating);
  $('#air').setAttribute('aria-pressed', volcano.pumping);
  const heatUp = $('#heat-up');
  heatUp.hidden = !on || !volcano.heating || volcano.target === null;
  heatUp.max = Math.max(1, volcano.target - MIN_TEMP);
  heatUp.value = Math.max(0, volcano.temp - MIN_TEMP);
  for (const btn of document.querySelectorAll('[data-action="run"]')) btn.disabled = !on || running !== null;
  renderInfo();
}

// Labels are always listed; values only while connected.
function renderInfo() {
  const { info } = volcano;
  const known = volcano.ready;
  const rows = [
    ['Device name', () => info.name],
    ['Serial number', () => info.serial],
    ['Firmware', () => info.firmware],
    ['Bootloader', () => info.bootloader],
    ['BLE firmware', () => info.bleFirmware],
    ['Code number', () => info.codeNumber ?? 'not readable'],
    ['Operating hours', () => `${volcano.useHours}h ${volcano.useMinutes}m`],
    ['Auto-off', () => `${Math.round(volcano.autoOffLeft / 60)} of ${Math.round(info.autoOffTime / 60)} min left`],
    ['LED brightness', () => info.brightness],
    ...[1, 2, 3].map((n) => [`Status register ${n}`, () => formatStatus(n, volcano[`status${n}`])]),
    ['Error history 1', () => info.history1],
    ['Error history 2', () => info.history2],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  $('#info').replaceChildren(...rows.map(([label, value]) => {
    const line = document.createElement('li');
    line.textContent = `${label}:`.padEnd(width) + (known ? value() : '');
    return line;
  }));
}

function formatStatus(register, value) {
  const hex = `0x${value.toString(16).padStart(4, '0')}`;
  const flags = statusFlags(register, value);
  return flags.length ? `${hex} · ${flags.join(', ')}` : hex;
}

function renderWorkflows() {
  const list = $('#workflows');
  list.replaceChildren();
  for (const [i, wf] of workflows.entries()) {
    const item = $('#workflow-item').content.cloneNode(true);
    const temps = wf.steps.map((s) => s.temp);
    const [first] = wf.steps;
    const li = item.querySelector('li');
    li.dataset.index = i;
    const isRunning = lastRun?.wf === wf && lastRun.state === 'running';
    if (lastRun?.wf === wf) li.dataset.state = lastRun.state;
    if (isRunning) item.querySelector('[data-action="run"]').textContent = 'Running…';
    item.querySelector('.name').textContent = wf.name;
    const summary = wf.steps.length === 1
      ? `${first.temp} °C · wait ${first.hold} s · air ${first.air} s`
      : `${wf.steps.length} steps · ${Math.min(...temps)}–${Math.max(...temps)} °C`;
    item.querySelector('.summary').textContent = isRunning
      ? `${summary} · step ${lastRun.step + 1}/${wf.steps.length}`
      : summary;
    list.append(item);
  }
  renderDevice();
}

async function run(wf) {
  running = new AbortController();
  lastRun = { wf, state: 'running', step: 0 };
  $('#stop').hidden = false;
  renderWorkflows();
  try {
    await runWorkflow(volcano, wf, {
      signal: running.signal,
      onProgress: ({ index, step, phase }) => {
        lastRun.step = index;
        $('#progress').textContent = `${wf.name}: ${PHASE_LABEL[phase]} ${step.temp} °C`;
        log(`workflow ${wf.name}: step ${index + 1}/${wf.steps.length}, ${PHASE_LABEL[phase]} ${step.temp} °C`);
        renderWorkflows();
      },
    });
    $('#progress').textContent = `${wf.name}: done`;
    lastRun.state = 'done';
  } catch (err) {
    lastRun = null;
    $('#progress').textContent = err.name === 'AbortError' ? `${wf.name}: stopped` : `${wf.name}: ${err.message}`;
  } finally {
    log(`workflow ${$('#progress').textContent}`);
    $('#progress').textContent = '';
    running = null;
    $('#stop').hidden = true;
    renderWorkflows();
  }
}

function addStepRow(step) {
  const row = $('#step-row').content.cloneNode(true);
  const temp = row.querySelector('[name="temp"]');
  temp.min = MIN_TEMP;
  temp.max = MAX_TEMP;
  temp.value = step.temp;
  row.querySelector('[name="hold"]').value = step.hold;
  row.querySelector('[name="air"]').value = step.air;
  $('#steps').append(row);
  numberSteps();
}

function numberSteps() {
  for (const [i, cell] of document.querySelectorAll('#steps .index').entries()) cell.textContent = i + 1;
}

function openEditor(index) {
  editing = index;
  const wf = workflows[index] ?? { name: '', steps: [{ temp: 185, hold: 0, air: 10 }] };
  $('#wf-name').value = wf.name;
  $('#steps').replaceChildren();
  wf.steps.forEach(addStepRow);
  $('#delete').hidden = index < 0;
  $('#editor').showModal();
}

// Wiring

if (!navigator.bluetooth) {
  setStatus('Web Bluetooth is unavailable: use Chrome or Chromium on https or localhost.');
  $('#connect').disabled = true;
}

volcano.addEventListener('log', (e) => log(e.detail));
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const box = $(btn.dataset.copy);
    getSelection().selectAllChildren(box);
    const lines = [...box.children].map((li) => li.textContent);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
}

volcano.addEventListener('change', () => {
  if (!volcano.connected) {
    running?.abort();
    setStatus('Not connected');
  }
  renderDevice();
});

$('#connect').addEventListener('click', async () => {
  if (volcano.connected) return volcano.disconnect();
  setStatus('Connecting…');
  try {
    await volcano.connect();
  } catch (err) {
    setStatus(`Connect failed: ${err.message}`);
    log(`connect failed: ${err.message}`);
  }
});

const targetInput = $('#target-input');
targetInput.min = MIN_TEMP;
targetInput.max = MAX_TEMP;

$('#target-form').addEventListener('submit', (e) => {
  e.preventDefault();
  volcano.setTarget(Number(targetInput.value)).catch(() => {});
});

// Failures already show in the debug log.
$('#heat').addEventListener('click', () => volcano.heat(!volcano.heating).catch(() => {}));
$('#air').addEventListener('click', () => volcano.air(!volcano.pumping).catch(() => {}));

$('#workflows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const index = Number(btn.closest('li').dataset.index);
  if (btn.dataset.action === 'run') run(workflows[index]);
  else openEditor(index);
});

$('#stop').addEventListener('click', () => running?.abort());
$('#new').addEventListener('click', () => openEditor(-1));

$('#add-step').addEventListener('click', () => {
  const last = [...document.querySelectorAll('#steps [name="temp"]')].at(-1);
  addStepRow({ temp: Math.min(MAX_TEMP, Number(last?.value ?? 180) + 5), hold: 0, air: 10 });
});

$('#steps').addEventListener('click', (e) => {
  if (!e.target.closest('[data-action="remove"]')) return;
  if ($('#steps').rows.length > 1) e.target.closest('tr').remove();
  numberSteps();
});

$('#cancel').addEventListener('click', () => $('#editor').close());

$('#delete').addEventListener('click', () => {
  if (!confirm(`Delete "${workflows[editing].name}"?`)) return;
  workflows.splice(editing, 1);
  save();
  renderWorkflows();
  $('#editor').close();
});

$('#editor').addEventListener('close', () => {
  if ($('#editor').returnValue !== 'save') return;
  $('#editor').returnValue = '';
  const wf = {
    name: $('#wf-name').value.trim(),
    steps: [...$('#steps').rows].map((row) => ({
      temp: Number(row.querySelector('[name="temp"]').value),
      hold: Number(row.querySelector('[name="hold"]').value),
      air: Number(row.querySelector('[name="air"]').value),
    })),
  };
  if (editing < 0) workflows.push(wf);
  else workflows[editing] = wf;
  save();
  renderWorkflows();
});

renderWorkflows();
