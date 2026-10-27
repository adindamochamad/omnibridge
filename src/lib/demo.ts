import type { DiscoveredDevice } from './types.js';

export interface DemoScenario {
  id: string;
  name: string;
  description: string;
  emoji: string;
  manufacturer: string;
  product: string;
  baud: number;
  interval_ms: number;
  generate: () => Uint8Array;
}

const encoder = new TextEncoder();

// ── CAS Scale ──────────────────────────────────────────────────────────────
let scaleWeight = 1.234;
let scaleTarget = 1.234;
let scaleStepCount = 0;
function casScaleGen(): Uint8Array {
  // Every ~30 readings, pick a new target weight (simulating item changes)
  if (scaleStepCount++ % 30 === 0) {
    scaleTarget = 0.5 + Math.random() * 4.5;
  }
  // Drift toward target with noise
  scaleWeight += (scaleTarget - scaleWeight) * 0.15 + (Math.random() - 0.5) * 0.003;
  const stable = Math.abs(scaleTarget - scaleWeight) < 0.01 ? 'ST' : 'US';
  const line = `${stable},GS,  ${scaleWeight.toFixed(3)} kg\r\n`;
  return encoder.encode(line);
}

// ── GPS NMEA ───────────────────────────────────────────────────────────────
let gpsLat = -6.2088; // Jakarta
let gpsLon = 106.8456;
function nmeaChecksum(sentence: string): string {
  let cs = 0;
  for (let i = 0; i < sentence.length; i++) cs ^= sentence.charCodeAt(i);
  return cs.toString(16).toUpperCase().padStart(2, '0');
}
function gpsGen(): Uint8Array {
  // Simulate slow walking speed
  gpsLat += (Math.random() - 0.5) * 0.00002;
  gpsLon += (Math.random() - 0.5) * 0.00002;
  const now = new Date();
  const hhmmss = `${String(now.getUTCHours()).padStart(2, '0')}${String(
    now.getUTCMinutes()
  ).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}.00`;
  const latDeg = Math.abs(Math.trunc(gpsLat));
  const latMin = Math.abs((gpsLat - Math.trunc(gpsLat)) * 60);
  const latStr = `${String(latDeg).padStart(2, '0')}${latMin.toFixed(4).padStart(7, '0')}`;
  const lonDeg = Math.abs(Math.trunc(gpsLon));
  const lonMin = Math.abs((gpsLon - Math.trunc(gpsLon)) * 60);
  const lonStr = `${String(lonDeg).padStart(3, '0')}${lonMin.toFixed(4).padStart(7, '0')}`;
  const body = `GPGGA,${hhmmss},${latStr},${gpsLat < 0 ? 'S' : 'N'},${lonStr},${gpsLon < 0 ? 'W' : 'E'},1,08,0.9,25.3,M,-10.2,M,,`;
  const line = `$${body}*${nmeaChecksum(body)}\r\n`;
  return encoder.encode(line);
}

// ── Modbus RTU PLC (binary protocol showcase) ──────────────────────────────
// Emits responses to "read holding registers" (function 0x03) as if polled by a master.
// Demonstrates binary protocol investigation — Claude must use tool use to identify.
const MODBUS_SLAVE = 0x01;
const MODBUS_FUNC_READ = 0x03;
// Register map: temp×10, pressure_hPa, flow_L/min, motor_RPM, valve_%, alarm, runtime_min, current_A×10, energy_kWh, setpoint.
// Values stay non-zero so a broken CRC is two bytes at the end, not a blank tail of reserved zeros.
let modbusRegisters = [0x01fe, 0x03f5, 0x022d, 0x0708, 0x024b, 0x0103, 0x0190, 0x0234, 0x0158, 0x02bc];

function modbusCrc16(data: number[]): [number, number] {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return [crc & 0xff, (crc >> 8) & 0xff];
}

function modbusPlcGen(): Uint8Array {
  // Drift registers slightly for realistic variation
  modbusRegisters[0] += Math.random() < 0.5 ? -1 : 1;
  modbusRegisters[1] += Math.random() < 0.5 ? -1 : 1;
  modbusRegisters[2] = Math.max(0, modbusRegisters[2] + (Math.random() < 0.5 ? -1 : 1));
  modbusRegisters[3] += Math.random() < 0.5 ? -5 : 5;
  modbusRegisters[4] = Math.max(0, Math.min(100, modbusRegisters[4] + (Math.random() < 0.5 ? -1 : 1)));

  const byteCount = modbusRegisters.length * 2;
  const frame: number[] = [MODBUS_SLAVE, MODBUS_FUNC_READ, byteCount];
  for (const reg of modbusRegisters) {
    frame.push((reg >> 8) & 0xff); // hi byte (Modbus is big-endian for register data)
    frame.push(reg & 0xff);
  }
  const [crcLo, crcHi] = modbusCrc16(frame);
  frame.push(crcLo, crcHi);
  return new Uint8Array(frame);
}

// ── Arduino sensor ─────────────────────────────────────────────────────────
let sensorT = 24.0;
let sensorH = 62.0;
function sensorGen(): Uint8Array {
  sensorT += (Math.random() - 0.5) * 0.2;
  sensorH += (Math.random() - 0.5) * 0.5;
  sensorT = Math.max(18, Math.min(32, sensorT));
  sensorH = Math.max(40, Math.min(85, sensorH));
  const light = Math.max(0, Math.floor(200 + Math.random() * 600));
  const line = `temp=${sensorT.toFixed(1)},humid=${sensorH.toFixed(1)},light=${light}\r\n`;
  return encoder.encode(line);
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'cas-scale',
    name: 'CAS Weighing Scale',
    description: 'Industrial scale, ASCII with stability flag (ST/US)',
    emoji: '⚖️',
    manufacturer: 'CAS Corp (Demo)',
    product: 'CL5000-J',
    baud: 9600,
    interval_ms: 250,
    generate: casScaleGen,
  },
  {
    id: 'nmea-gps',
    name: 'GPS Receiver',
    description: 'GNSS module emitting NMEA 0183 sentences',
    emoji: '🛰️',
    manufacturer: 'u-blox (Demo)',
    product: 'NEO-M9N',
    baud: 9600,
    interval_ms: 1000,
    generate: gpsGen,
  },
  {
    id: 'arduino-sensor',
    name: 'Arduino Sensor Array',
    description: 'DHT22 + LDR, key=value CSV format',
    emoji: '🌡️',
    manufacturer: 'Arduino (Demo)',
    product: 'Nano with DHT22 + LDR',
    baud: 115200,
    interval_ms: 500,
    generate: sensorGen,
  },
  {
    id: 'modbus-plc',
    name: 'Modbus RTU PLC',
    description: 'Industrial PLC · binary protocol · 10 registers with CRC16-IBM framing',
    emoji: '🏭',
    manufacturer: 'Schneider Electric (Demo)',
    product: 'Modicon M221',
    baud: 19200,
    interval_ms: 600,
    generate: modbusPlcGen,
  },
];

export function isDemoPort(port: string): boolean {
  return port.startsWith('demo://');
}

export function demoScenarioFromPort(port: string): DemoScenario | null {
  const id = port.replace('demo://', '');
  return DEMO_SCENARIOS.find((s) => s.id === id) ?? null;
}

export function demoScenarioToDevice(scenario: DemoScenario): DiscoveredDevice {
  return {
    port: `demo://${scenario.id}`,
    device_class: 'demo',
    label: 'DEMO',
    manufacturer: scenario.manufacturer,
    product: scenario.product,
    vid: null,
    pid: null,
    serial_number: `demo-${scenario.id}`,
    suggested_baud: scenario.baud,
  };
}

export function allDemoDevices(): DiscoveredDevice[] {
  return DEMO_SCENARIOS.map(demoScenarioToDevice);
}
