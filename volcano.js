// GATT protocol of the Volcano Hybrid, as used by app.storz-bickel.com v3.4.1.
const uuid = (prefix) => `${prefix}-5354-4f52-5a26-4249434b454c`;

const NAME_PREFIX = 'S&B VOLCANO';
const SERVICE_STATE = uuid('10100000');
const SERVICE_CONTROL = uuid('10110000');

const CHAR = {
  serial: [SERVICE_STATE, uuid('10100008')],
  firmware: [SERVICE_STATE, uuid('10100003')],
  bootloader: [SERVICE_STATE, uuid('10100001')],
  bleFirmware: [SERVICE_STATE, uuid('10100004')],
  // The official app only writes here (4711, to enter firmware update). Never write it.
  codeNumber: [SERVICE_STATE, uuid('10100011')],
  status1: [SERVICE_STATE, uuid('1010000c')],
  status2: [SERVICE_STATE, uuid('1010000d')],
  status3: [SERVICE_STATE, uuid('1010000e')],
  history1: [SERVICE_STATE, uuid('10100015')],
  history2: [SERVICE_STATE, uuid('10100016')],
  brightness: [SERVICE_CONTROL, uuid('10110005')],
  autoOffLeft: [SERVICE_CONTROL, uuid('1011000c')],
  autoOffTime: [SERVICE_CONTROL, uuid('1011000d')],
  useHours: [SERVICE_CONTROL, uuid('10110015')],
  useMinutes: [SERVICE_CONTROL, uuid('10110016')],
  temp: [SERVICE_CONTROL, uuid('10110001')],
  target: [SERVICE_CONTROL, uuid('10110003')],
  heatOn: [SERVICE_CONTROL, uuid('1011000f')],
  heatOff: [SERVICE_CONTROL, uuid('10110010')],
  airOn: [SERVICE_CONTROL, uuid('10110013')],
  airOff: [SERVICE_CONTROL, uuid('10110014')],
};

const STATUS_HEAT = 0x0020;
const STATUS_AIR = 0x2000;

// Bits the official app interprets, per status register. A flag is set when any of its mask bits is.
const STATUS_FLAGS = {
  1: [[STATUS_HEAT, 'heat'], [0x0200, 'auto BLE shutdown'], [STATUS_AIR, 'pump'], [0x4018, 'error']],
  2: [[0x0200, 'fahrenheit'], [0x1000, 'display off while cooling'], [0x003b, 'error']],
  3: [[0x0400, 'vibration off']],
};

export function statusFlags(register, value) {
  return STATUS_FLAGS[register].filter(([mask]) => (value & mask) !== 0).map(([, name]) => name);
}

export function hexBytes(data) {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

export const MIN_TEMP = 40;
export const MAX_TEMP = 230;

// Temperatures travel as tenths of a degree Celsius, little-endian.
export function encodeTarget(celsius) {
  const buf = new DataView(new ArrayBuffer(4));
  buf.setUint32(0, Math.round(celsius * 10), true);
  return buf.buffer;
}

export function decodeTemp(view) {
  return view.getUint16(0, true) / 10;
}

export class Volcano extends EventTarget {
  temp = null;
  target = null;
  heating = false;
  pumping = false;
  info = null;
  status1 = null;
  status2 = null;
  status3 = null;
  useHours = null;
  useMinutes = null;
  autoOffLeft = null;

  #device = null;
  #chars = {};
  // Chrome rejects a GATT operation while another is in flight, so all of them run in series.
  #queue = Promise.resolve();
  #ready = false;

  get connected() {
    return this.#device?.gatt.connected ?? false;
  }

  // True once every value above has been read for the current connection.
  get ready() {
    return this.connected && this.#ready;
  }

  async connect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }],
      optionalServices: [SERVICE_STATE, SERVICE_CONTROL],
    });
    this.#log(`selected ${device.name}`);
    this.#ready = false;
    this.#device = device;
    this.#device.addEventListener('gattserverdisconnected', () => {
      this.#ready = false;
      this.#log('disconnected');
      this.#changed();
    });
    const server = await this.#device.gatt.connect();
    this.#log('GATT connected');
    const services = {
      [SERVICE_STATE]: await server.getPrimaryService(SERVICE_STATE),
      [SERVICE_CONTROL]: await server.getPrimaryService(SERVICE_CONTROL),
    };
    for (const [name, [service, char]] of Object.entries(CHAR)) {
      this.#chars[name] = await services[service].getCharacteristic(char);
    }
    this.#log(`resolved ${Object.keys(CHAR).length} characteristics`);
    await this.#subscribe('temp', (v) => { this.temp = decodeTemp(v); });
    await this.#subscribe('target', (v) => { this.target = decodeTemp(v); });
    await this.#subscribe('status1', (v) => {
      this.status1 = v.getUint16(0, true);
      this.heating = (this.status1 & STATUS_HEAT) !== 0;
      this.pumping = (this.status1 & STATUS_AIR) !== 0;
    });
    await this.#subscribe('status2', (v) => { this.status2 = v.getUint16(0, true); });
    this.status3 = (await this.#read('status3')).getUint16(0, true);
    await this.#subscribe('useHours', (v) => { this.useHours = v.getUint16(0, true); });
    await this.#subscribe('useMinutes', (v) => { this.useMinutes = v.getUint16(0, true); });
    await this.#subscribe('autoOffLeft', (v) => { this.autoOffLeft = v.getUint16(0, true); });
    this.info = {
      name: this.#device.name,
      serial: await this.#readText('serial', 8),
      firmware: await this.#readText('firmware', 8),
      bootloader: await this.#readText('bootloader'),
      bleFirmware: await this.#readText('bleFirmware'),
      codeNumber: await this.#read('codeNumber').then((v) => v.getUint16(0, true), () => null),
      autoOffTime: (await this.#read('autoOffTime')).getUint16(0, true),
      brightness: (await this.#read('brightness')).getUint16(0, true),
      history1: hexBytes(await this.#read('history1')),
      history2: hexBytes(await this.#read('history2')),
    };
    this.#ready = true;
    this.#log('ready');
    this.#changed();
  }

  disconnect() {
    this.#log('disconnect requested');
    this.#device?.gatt.disconnect();
  }

  setTarget(celsius) {
    return this.#write('target', encodeTarget(celsius));
  }

  heat(on) {
    return this.#write(on ? 'heatOn' : 'heatOff', new Uint8Array([0]));
  }

  air(on) {
    return this.#write(on ? 'airOn' : 'airOff', new Uint8Array([0]));
  }

  async #subscribe(name, apply) {
    const char = this.#chars[name];
    char.addEventListener('characteristicvaluechanged', () => {
      this.#log(`notify ${name}: ${hexBytes(char.value)}`);
      apply(char.value);
      this.#changed();
    });
    await this.#serial(`subscribe ${name}`, () => char.startNotifications());
    apply(await this.#read(name));
  }

  async #read(name) {
    const value = await this.#serial(`read ${name}`, () => this.#chars[name].readValue());
    this.#log(`read ${name}: ${hexBytes(value)}`);
    return value;
  }

  async #readText(name, length) {
    return new TextDecoder().decode(await this.#read(name)).replace(/\0/g, '').slice(0, length).trim();
  }

  #write(name, bytes) {
    this.#log(`write ${name}: ${hexBytes(bytes)}`);
    return this.#serial(`write ${name}`, () => this.#chars[name].writeValueWithResponse(bytes));
  }

  #serial(label, op) {
    const run = this.#queue.then(op).catch((err) => {
      this.#log(`${label} failed: ${err.message}`);
      throw err;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  #log(text) {
    this.dispatchEvent(new CustomEvent('log', { detail: text }));
  }

  #changed() {
    this.dispatchEvent(new Event('change'));
  }
}
