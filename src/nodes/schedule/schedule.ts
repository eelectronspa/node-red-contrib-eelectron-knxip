// eelectron-knxip-schedule — fire a payload to a configured GA on a schedule.
//
// Author: Jamel Nacef <jamel.nacef@eelectron.com>
// SPDX-License-Identifier: Apache-2.0
//
// Two modes:
//   - 'cron'      → 5-field cron expression, evaluated each minute
//   - 'interval'  → fire every N seconds
//
// Output shape mirrors `eelectron-knxip-ets-inject` so a downstream
// `eelectron-knxip-writer` can auto-encode via the bound ETS DPT without an
// encoder node in between.

import type { Node, NodeAPI, NodeDef, NodeMessage } from 'node-red';
import type { KnxEtsConfigNode } from '../shared/configNode';
import { type CronMatcher, compileCron } from '../../util/cron';

interface ScheduleProps {
  etsConfig: string;
  ga?: string;
  payloadJson?: string;
  /** 'cron' | 'interval'. */
  mode?: string;
  /** Cron expression for `mode='cron'`. */
  cron?: string;
  /** Interval in seconds for `mode='interval'`. */
  intervalSeconds?: string | number;
  /** Fire once at deploy in addition to the schedule. */
  fireOnDeploy?: boolean;
}

type Def = NodeDef & ScheduleProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeParseJson(text: string | undefined): unknown {
  if (text === undefined || text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export = function (RED: NodeAPI) {
  function ScheduleCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.etsConfig) as unknown as
      | (Node & KnxEtsConfigNode)
      | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no ETS config' });
      return;
    }

    const ga = (def.ga ?? '').trim();
    const payload = safeParseJson(def.payloadJson);
    const entry = ga ? cfg.map.get(ga) : null;
    if (!ga) {
      self.status({ fill: 'yellow', shape: 'ring', text: 'pick a GA' });
      return;
    }
    if (!entry) {
      self.status({ fill: 'yellow', shape: 'ring', text: `${ga} not in ETS` });
      // Still register the schedule — user might import the project later
      // and we should pick up automatically on redeploy.
    }

    const mode = def.mode === 'interval' ? 'interval' : 'cron';
    const fireOnDeploy = def.fireOnDeploy === true;

    let fires = 0;
    function setOk(extra?: string): void {
      self.status({
        fill: 'green',
        shape: 'dot',
        text:
          ga + (entry?.dpt ? ' · ' + entry.dpt : '') +
          (extra ? ' · ' + extra : '') +
          ' · fires=' + fires,
      });
    }
    function setIdle(extra?: string): void {
      self.status({
        fill: 'grey',
        shape: 'dot',
        text:
          ga + (entry?.dpt ? ' · ' + entry.dpt : '') +
          (extra ? ' · ' + extra : '') +
          ' · fires=' + fires,
      });
    }

    function fire(): void {
      const e = ga ? cfg!.map.get(ga) : null;
      if (!ga || !e) return;
      fires += 1;
      self.send({
        payload,
        topic: ga,
        ...(e.dpt ? { dpt: e.dpt } : {}),
        ...(e.name ? { gaName: e.name } : {}),
      } as NodeMessage);
      setOk(new Date().toISOString().slice(11, 19));
    }

    let cronTimer: NodeJS.Timeout | null = null;
    let intervalTimer: NodeJS.Timeout | null = null;
    let onceTimer: NodeJS.Timeout | null = null;

    if (mode === 'cron') {
      const expr = (def.cron ?? '').trim();
      let matcher: CronMatcher;
      try {
        matcher = compileCron(expr);
      } catch (err) {
        self.error(`Invalid cron expression "${expr}": ${(err as Error).message}`);
        self.status({ fill: 'red', shape: 'ring', text: 'bad cron' });
        return;
      }
      // Tick every minute, aligned to the next minute boundary so a 09:00
      // schedule actually fires within the first second of 09:00 rather than
      // up to 60 s late.
      const now = new Date();
      const msToNextMinute =
        60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 50;
      const startTimer = setTimeout(() => {
        const tick = () => {
          if (matcher.matches(new Date())) fire();
        };
        tick();
        cronTimer = setInterval(tick, 60_000);
        cronTimer.unref?.();
      }, msToNextMinute);
      startTimer.unref?.();
      // Stash so close() clears it too.
      cronTimer = startTimer;
      setIdle('cron: ' + expr);
    } else {
      const intervalMs = Math.round(toNumber(def.intervalSeconds, 60) * 1000);
      intervalTimer = setInterval(fire, intervalMs);
      intervalTimer.unref?.();
      setIdle('every ' + Math.round(intervalMs / 1000) + ' s');
    }

    if (fireOnDeploy) {
      onceTimer = setTimeout(fire, 100);
      onceTimer.unref?.();
    }

    // Manual fire via the inject button.
    self.on('input', () => fire());

    self.on('close', (_removed: boolean, done: () => void) => {
      if (cronTimer) {
        clearTimeout(cronTimer);
        clearInterval(cronTimer);
      }
      if (intervalTimer) clearInterval(intervalTimer);
      if (onceTimer) clearTimeout(onceTimer);
      done();
    });
  }

  RED.nodes.registerType('eelectron-knxip-schedule', ScheduleCtor as unknown as () => void);
};
