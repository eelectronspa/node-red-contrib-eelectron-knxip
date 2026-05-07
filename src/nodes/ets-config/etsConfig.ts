// eelectron-knxip-ets-config — config node holding a parsed ETS project map.
// Each instance owns its own ETSProjectMap; multiple ETS configs can coexist
// (e.g. different sites/projects) just like the tunnel config nodes.
//
// Two ingestion paths:
//   1. CSV (group-address export) — text, stored verbatim in `csvData`,
//      parsed at deploy time.
//   2. .knxproj archive — binary, parsed by an admin endpoint at upload time;
//      the resulting GA list is stashed as JSON in `parsedEntries`. We don't
//      keep the raw archive in flows.json (typically multi-MB).

import type { Node, NodeAPI, NodeDef } from 'node-red';
import { ETSProjectMap } from '../../ets/projectMap';
import { type KnxprojGroupAddress, parseKnxproj } from '../../ets/knxproj';
import { getDpt, listDpts } from '../../dpt';
import type { KnxEtsConfigNode } from '../shared/configNode';

interface ETSConfigProps {
  /** Raw CSV content stored alongside the node config. */
  csvData?: string;
  /** Pre-parsed GA list from a .knxproj upload (JSON-stringified). */
  parsedEntries?: string;
  /** Free-text source hint (informational only). */
  source?: 'csv-upload' | 'csv-paste' | 'knxproj' | 'unknown';
}

type Def = NodeDef & ETSConfigProps;

export = function (RED: NodeAPI) {
  // Admin endpoint: list group addresses for a specific ETS config node.
  // Editor uses this for typeahead in writer/listener GA fields.
  RED.httpAdmin.get(
    '/eelectron-knxip-ets-config/:id/group-addresses',
    RED.auth.needsPermission('flows.read'),
    (req, res) => {
      const rawId = req.params.id;
      const id =
        typeof rawId === 'string'
          ? rawId
          : Array.isArray(rawId)
            ? String(rawId[0] ?? '')
            : '';
      const node = RED.nodes.getNode(id) as unknown as KnxEtsConfigNode | null;
      if (!node?.map) {
        res.status(404).json([]);
        return;
      }
      const out = node.map.list().map((e) => ({
        ga: e.ga,
        name: e.name,
        dpt: e.dpt,
      }));
      res.json(out);
    },
  );

  // Admin endpoint: list registered DPT codecs (id, name, optional unit).
  RED.httpAdmin.get(
    '/eelectron-knxip/dpts',
    RED.auth.needsPermission('flows.read'),
    (_req, res) => {
      const out = listDpts().map((id) => {
        const codec = getDpt(id);
        return {
          id,
          name: codec.name,
          ...(codec.unit !== undefined ? { unit: codec.unit } : {}),
        };
      });
      res.json(out);
    },
  );

  // Admin endpoint: parse a .knxproj upload and return the extracted GA list.
  // Editor sends the file body as application/octet-stream (bypasses the
  // global JSON/urlencoded body parsers, which can't handle multi-MB binaries).
  RED.httpAdmin.post(
    '/eelectron-knxip-ets-config/parse-knxproj',
    RED.auth.needsPermission('flows.write'),
    (req, res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX = 100 * 1024 * 1024; // 100 MB hard cap

      const onData = (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX) {
          res.status(413).json({ error: 'Upload exceeds 100 MB cap' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (res.headersSent) return;
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          res.status(400).json({ error: 'Empty upload' });
          return;
        }
        try {
          const result = parseKnxproj(buf);
          res.json(result);
        } catch (err) {
          res.status(400).json({ error: (err as Error).message });
        }
      };
      const onError = (err: Error) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    },
  );

  function EtsConfigCtor(this: Node & KnxEtsConfigNode, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const map = new ETSProjectMap();
    self.map = map;
    self.entryCount = 0;

    const finishLoad = (
      label: string,
      result: { entries: number; withDpt: number; warnings: string[]; unknownDpt: { ga: string; dptRaw: string }[] },
    ) => {
      self.entryCount = result.entries;
      if (result.warnings.length > 0) {
        self.warn(
          `${label} parsed with ${result.warnings.length} warning(s): ${result.warnings.slice(0, 3).join('; ')}${result.warnings.length > 3 ? '…' : ''}`,
        );
      }
      if (result.unknownDpt.length > 0) {
        self.warn(
          `ETS: ${result.unknownDpt.length} group addresses use a DPT not in our codec library`,
        );
      }
      self.log(
        `${label}: ${result.entries} group addresses (${result.withDpt} with known DPT)`,
      );
    };

    try {
      if (def.parsedEntries && def.parsedEntries.trim()) {
        const entries = JSON.parse(def.parsedEntries) as KnxprojGroupAddress[];
        if (!Array.isArray(entries)) throw new Error('parsedEntries is not an array');
        const result = map.loadParsedEntries(entries);
        finishLoad('ETS project (.knxproj)', result);
      } else if (def.csvData && def.csvData.trim()) {
        const result = map.loadCsv(def.csvData);
        finishLoad('ETS CSV', result);
      } else {
        self.warn('ETS config has no project data — bound nodes will pass through');
      }
    } catch (err) {
      self.error(`Failed to load ETS project: ${(err as Error).message}`);
    }
  }

  RED.nodes.registerType(
    'eelectron-knxip-ets-config',
    EtsConfigCtor as unknown as () => void,
  );
};
