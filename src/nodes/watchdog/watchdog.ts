// eelectron-knxip-watchdog — fires an alarm when a watched group address has
// been silent longer than its timeout, and a recovery when it speaks again.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Typical use: HVAC sensors, presence detectors, weather feeds — any GA that
// is *expected* to publish on a known cadence. If the bus device crashes,
// loses power, or its programming runs amok, the watchdog routes an alarm
// message you can pipe into notifications, dashboards, or fallback logic.

import type { Node, NodeAPI, NodeDef } from 'node-red';
import { GroupAddress } from '../../core/address';
import { CEMIFrame, CEMIMessageCode } from '../../core/cemi';
import type { KnxConfigNode, KnxEtsConfigNode } from '../shared/configNode';

interface WatchdogProps {
  /** Tunnel-config node id (required). */
  config: string;
  /** Optional ETS config — used for GA name resolution in messages + status. */
  etsConfig?: string;
  /** Comma- or newline-separated list of group addresses to watch. */
  groupAddresses?: string;
  /** Per-GA timeout in seconds. Default 300 s. */
  timeoutSeconds?: string | number;
  /** Check cadence in seconds. Default = `timeoutSeconds / 5`, clamped 5..60. */
  checkIntervalSeconds?: string | number;
  /** Treat the deploy moment as "last seen" so we don't alarm immediately. */
  seedOnDeploy?: boolean;
}

type Def = NodeDef & WatchdogProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseGroupAddresses(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export = function (RED: NodeAPI) {
  function WatchdogCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.config) as unknown as (Node & KnxConfigNode) | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }
    const etsCfg = def.etsConfig
      ? (RED.nodes.getNode(def.etsConfig) as unknown as KnxEtsConfigNode | null)
      : null;

    const timeoutMs = Math.round(toNumber(def.timeoutSeconds, 300) * 1000);
    // Default check cadence: a fifth of the timeout, bounded so we don't
    // fire wildly often or too lazily. Both bounds in milliseconds.
    const defaultIntervalMs = Math.min(60_000, Math.max(5_000, Math.round(timeoutMs / 5)));
    const intervalMs = Math.round(toNumber(def.checkIntervalSeconds, defaultIntervalMs / 1000) * 1000);
    const seedOnDeploy = def.seedOnDeploy !== false; // default true

    let watched: Map<number, { ga: string; gaName?: string }>;
    try {
      const list = parseGroupAddresses(def.groupAddresses);
      watched = new Map();
      for (const a of list) {
        const ga = new GroupAddress(a, cfg.groupAddressStyle);
        const gaStr = ga.toString();
        const entry: { ga: string; gaName?: string } = { ga: gaStr };
        if (etsCfg?.map) {
          const ets = etsCfg.map.get(ga);
          if (ets?.name) entry.gaName = ets.name;
        }
        watched.set(ga.raw, entry);
      }
    } catch (err) {
      self.error(`Invalid group address: ${(err as Error).message}`);
      self.status({ fill: 'red', shape: 'ring', text: 'bad GA' });
      return;
    }

    if (watched.size === 0) {
      self.status({ fill: 'yellow', shape: 'ring', text: 'no GAs configured' });
      return;
    }

    // Per-GA state. lastSeen=null means never seen since deploy/reset.
    type State = { lastSeen: number | null; alarmed: boolean };
    const state = new Map<number, State>();
    const seedTs = seedOnDeploy ? Date.now() : null;
    for (const raw of watched.keys()) {
      state.set(raw, { lastSeen: seedTs, alarmed: false });
    }

    function setOverallStatus(): void {
      let alarmed = 0;
      let neverSeen = 0;
      for (const [raw, s] of state) {
        if (s.alarmed) alarmed += 1;
        if (s.lastSeen === null) neverSeen += 1;
        void raw;
      }
      if (alarmed > 0) {
        self.status({ fill: 'red', shape: 'dot', text: `${alarmed} alarm(s)` });
      } else if (neverSeen > 0) {
        self.status({ fill: 'yellow', shape: 'ring', text: `${watched.size} watching (${neverSeen} unseen)` });
      } else {
        self.status({ fill: 'green', shape: 'dot', text: `${watched.size} watching` });
      }
    }

    function emit(raw: number, transition: 'alarm' | 'recovery'): void {
      const meta = watched.get(raw);
      if (!meta) return;
      const s = state.get(raw);
      const msg = {
        topic: meta.ga,
        payload: {
          ga: meta.ga,
          ...(meta.gaName ? { gaName: meta.gaName } : {}),
          state: transition,
          lastSeen: s?.lastSeen ?? null,
          ageMs: s?.lastSeen ? Date.now() - s.lastSeen : null,
          timeoutMs,
        },
      };
      self.send(msg as unknown as Parameters<typeof self.send>[0]);
    }

    const onCemi = (cemi: CEMIFrame) => {
      if (cemi.code !== CEMIMessageCode.L_DATA_IND) return;
      const data = cemi.data;
      if (!(data.dstAddr instanceof GroupAddress)) return;
      const raw = data.dstAddr.raw;
      const s = state.get(raw);
      if (!s) return; // not a watched GA
      const apci = data.payload;
      if (!apci) return;
      // Both writes and responses count as "still alive" — reads alone don't.
      if (apci.kind !== 'GroupValueWrite' && apci.kind !== 'GroupValueResponse') return;
      s.lastSeen = Date.now();
      if (s.alarmed) {
        s.alarmed = false;
        emit(raw, 'recovery');
        setOverallStatus();
      }
    };
    cfg.client.on('cemi', onCemi);
    cfg.attach(self.id);

    const checkTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [raw, s] of state) {
        // never-seen GAs only alarm if the seed wasn't applied (so the user
        // explicitly wants pre-deploy silence to count) AND they've been
        // silent past the timeout since reset/seed.
        const reference = s.lastSeen ?? 0;
        if (!s.alarmed && now - reference > timeoutMs) {
          s.alarmed = true;
          emit(raw, 'alarm');
          changed = true;
        }
      }
      if (changed) setOverallStatus();
    }, intervalMs);
    checkTimer.unref?.();

    setOverallStatus();

    self.on('close', (_removed: boolean, done: () => void) => {
      clearInterval(checkTimer);
      cfg.client.off('cemi', onCemi);
      cfg.detach(self.id);
      done();
    });
  }

  RED.nodes.registerType('eelectron-knxip-watchdog', WatchdogCtor as unknown as () => void);
};
