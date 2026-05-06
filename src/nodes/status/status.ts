// eelectron-knxip-status — emits messages on tunnel state transitions and
// surfaces queue depth + last-error in the node status indicator.

import type { Node, NodeAPI, NodeDef } from 'node-red';
import type { TunnelState } from '../../io/tunnel';
import type { KnxConfigNode } from '../shared/configNode';

interface StatusProps {
  config: string;
  /**
   * Optional cyclic emit cadence in ms. When set to a positive integer the node
   * emits the current state every N ms in addition to state-change events.
   * 0/empty = disabled.
   */
  cyclicIntervalMs?: string | number;
}

type Def = NodeDef & StatusProps;

function toNumber(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function statusFill(state: TunnelState): 'green' | 'yellow' | 'red' | 'grey' {
  switch (state) {
    case 'connected':
      return 'green';
    case 'connecting':
    case 'disconnecting':
      return 'yellow';
    case 'disconnected':
      return 'red';
  }
}

interface ErrorRecord {
  message: string;
  /** ISO timestamp when the error was last seen. */
  at: string;
  /** Severity bucket — warnings are recoverable, errors typically aren't. */
  level: 'warning' | 'error';
}

export = function (RED: NodeAPI) {
  function StatusCtor(this: Node, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const cfg = RED.nodes.getNode(def.config) as unknown as (Node & KnxConfigNode) | null;
    if (!cfg) {
      self.status({ fill: 'red', shape: 'ring', text: 'no config' });
      return;
    }

    let lastError: ErrorRecord | null = null;

    const refreshStatus = (state: TunnelState) => {
      const depth = cfg.client.sendQueueDepth ?? 0;
      const parts: string[] = [state];
      if (depth > 0) parts.push(`queue=${depth}`);
      if (lastError) parts.push(`!${lastError.message.slice(0, 32)}`);
      self.status({ fill: statusFill(state), shape: 'dot', text: parts.join(' · ') });
    };

    const emit = (state: TunnelState) => {
      refreshStatus(state);
      self.send({
        payload: state,
        topic: 'tunnel-state',
        knx: {
          state,
          queueDepth: cfg.client.sendQueueDepth ?? 0,
          assignedAddress: cfg.client.assignedAddress?.toString() ?? null,
          lastError,
        },
      } as unknown as Parameters<typeof self.send>[0]);
    };

    const onState = (state: TunnelState) => {
      // Clear lastError on a clean reconnect — the current tunnel is healthy again.
      if (state === 'connected' && lastError) lastError = null;
      emit(state);
    };

    const onWarning = (err: Error) => {
      lastError = { message: err.message, at: new Date().toISOString(), level: 'warning' };
      refreshStatus(cfg.client.state);
    };
    const onError = (err: Error) => {
      lastError = { message: err.message, at: new Date().toISOString(), level: 'error' };
      refreshStatus(cfg.client.state);
    };

    cfg.client.on('state', onState);
    cfg.client.on('warning', onWarning);
    cfg.client.on('error', onError);
    cfg.attach(self.id);
    emit(cfg.client.state); // initial snapshot on deploy

    const intervalMs = toNumber(def.cyclicIntervalMs, 0);
    let cyclicTimer: NodeJS.Timeout | null = null;
    if (intervalMs > 0) {
      cyclicTimer = setInterval(() => emit(cfg.client.state), intervalMs);
      cyclicTimer.unref?.();
    }

    self.on('close', (_removed: boolean, done: () => void) => {
      if (cyclicTimer) clearInterval(cyclicTimer);
      cfg.client.off('state', onState);
      cfg.client.off('warning', onWarning);
      cfg.client.off('error', onError);
      cfg.detach(self.id);
      done();
    });
  }

  RED.nodes.registerType('eelectron-knxip-status', StatusCtor as unknown as () => void);
};
