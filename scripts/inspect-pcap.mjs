#!/usr/bin/env node
// Minimal pcap reader → extract TCP-3671 payloads and split into KNX/IP frames.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: inspect-pcap.mjs <file.pcap>'); process.exit(1); }
const buf = readFileSync(file);

// Global header
const magicLE = buf.readUInt32LE(0);
const magicBE = buf.readUInt32BE(0);
let little;
if (magicLE === 0xa1b2c3d4) little = true;       // file written little-endian, bytes d4 c3 b2 a1
else if (magicBE === 0xa1b2c3d4) little = false; // file written big-endian, bytes a1 b2 c3 d4
else { console.error('not a pcap file (magic LE=' + magicLE.toString(16) + ' BE=' + magicBE.toString(16) + ')'); process.exit(2); }
const u32 = (off) => little ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
const linktype = u32(20);
console.log(`pcap linktype=${linktype}, ${little ? 'little' : 'big'}-endian`);

// Streams keyed by 4-tuple
const streams = new Map();

let off = 24;
let pkt = 0;
while (off + 16 <= buf.length) {
  const inclLen = u32(off + 8);
  const data = buf.subarray(off + 16, off + 16 + inclLen);
  off += 16 + inclLen;
  pkt++;
  if (linktype !== 1) continue; // only Ethernet supported

  // Ethernet
  if (data.length < 14) continue;
  const ethType = data.readUInt16BE(12);
  if (ethType !== 0x0800) continue; // IPv4 only
  const ip = data.subarray(14);
  const ihl = (ip[0] & 0x0f) * 4;
  if (ip[9] !== 6) continue; // TCP
  const srcIp = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
  const dstIp = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
  const tcp = ip.subarray(ihl);
  const srcPort = tcp.readUInt16BE(0);
  const dstPort = tcp.readUInt16BE(2);
  if (srcPort !== 3671 && dstPort !== 3671) continue;
  const dataOff = (tcp[12] >> 4) * 4;
  const payload = tcp.subarray(dataOff);
  if (payload.length === 0) continue;

  // Client = whichever side is NOT port 3671. Gateway = 3671.
  const clientIsSrc = srcPort !== 3671;
  const clientIp = clientIsSrc ? srcIp : dstIp;
  const clientPort = clientIsSrc ? srcPort : dstPort;
  const gwIp = clientIsSrc ? dstIp : srcIp;
  const key = `${clientIp}:${clientPort}<->${gwIp}:3671`;
  let s = streams.get(key);
  if (!s) { s = { events: [] }; streams.set(key, s); }
  const dir = clientIsSrc ? 'tx' : 'rx';
  s.events.push({ pkt, dir, payload: Buffer.from(payload) });
}

const SERVICE_NAMES = {
  0x0950: 'SECURE_WRAPPER',
  0x0951: 'SESSION_REQUEST',
  0x0952: 'SESSION_RESPONSE',
  0x0953: 'SESSION_AUTHENTICATE',
  0x0954: 'SESSION_STATUS',
  0x0205: 'SEARCH_REQUEST',
  0x0206: 'SEARCH_RESPONSE',
  0x0420: 'TUNNELLING_REQUEST',
  0x0421: 'TUNNELLING_ACK',
  0x0202: 'CONNECT_REQUEST',
  0x0204: 'CONNECT_RESPONSE',
  0x0207: 'CONNECTIONSTATE_REQUEST',
  0x0208: 'CONNECTIONSTATE_RESPONSE',
  0x0209: 'DISCONNECT_REQUEST',
  0x020a: 'DISCONNECT_RESPONSE',
};

for (const [key, s] of streams) {
  console.log(`\n=== stream ${key} (${s.events.length} segments) ===`);
  // Reassemble per direction (TCP can split frames)
  const buffers = { tx: Buffer.alloc(0), rx: Buffer.alloc(0) };
  let lastPkt = { tx: 0, rx: 0 };
  for (const ev of s.events) {
    buffers[ev.dir] = Buffer.concat([buffers[ev.dir], ev.payload]);
    lastPkt[ev.dir] = ev.pkt;
    while (buffers[ev.dir].length >= 6) {
      // Sanity-check: KNX/IP header starts with 06 10
      if (buffers[ev.dir][0] !== 0x06 || buffers[ev.dir][1] !== 0x10) {
        console.log(`  [${ev.dir}] non-KNX-IP byte 0x${buffers[ev.dir][0].toString(16)} at start, skipping`);
        buffers[ev.dir] = buffers[ev.dir].subarray(1);
        continue;
      }
      const totalLen = buffers[ev.dir].readUInt16BE(4);
      if (totalLen < 6 || totalLen > buffers[ev.dir].length) {
        if (totalLen > buffers[ev.dir].length) break; // wait for more
        buffers[ev.dir] = buffers[ev.dir].subarray(1);
        continue;
      }
      const frame = buffers[ev.dir].subarray(0, totalLen);
      buffers[ev.dir] = buffers[ev.dir].subarray(totalLen);
      const svc = frame.readUInt16BE(2);
      const name = SERVICE_NAMES[svc] ?? `0x${svc.toString(16)}`;
      console.log(`  [${ev.dir}#${lastPkt[ev.dir]}] ${name} len=${totalLen}: ${frame.toString('hex')}`);
    }
  }
}
