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
  //
  // The editor can send either:
  //   - application/octet-stream raw body (preferred for big files)
  //   - application/json {"fileBase64": "..."} (fallback when middleware
  //     in front of us has consumed the raw stream)
  //
  // Some Node-RED middleware stacks pre-consume request bodies, so we accept
  // whichever shape arrives at our handler. Logs include byte counts so the
  // failure mode (empty body, mid-stream truncation, base64 path) is obvious
  // in the Node-RED log.
  RED.httpAdmin.post(
    '/eelectron-knxip-ets-config/parse-knxproj',
    RED.auth.needsPermission('flows.write'),
    (req, res) => {
      const MAX = 100 * 1024 * 1024;

      const finish = (buf: Buffer, source: string) => {
        const log = RED.log;
        if (buf.length === 0) {
          log.warn(`[knxip] /parse-knxproj: empty body via ${source}`);
          res.status(400).json({ error: 'Empty upload — body could not be collected' });
          return;
        }
        log.info(
          `[knxip] /parse-knxproj: ${buf.length} bytes via ${source}`,
        );
        try {
          const result = parseKnxproj(buf);
          log.info(
            `[knxip] /parse-knxproj: parsed ${result.groupAddresses.length} GAs from "${result.projectName ?? '?'}"`,
          );
          res.json(result);
        } catch (err) {
          log.warn(`[knxip] /parse-knxproj: ${(err as Error).message}`);
          res.status(400).json({ error: (err as Error).message });
        }
      };

      // Path 1: middleware already populated req.body as a Buffer.
      const body = (req as { body?: unknown }).body;
      if (Buffer.isBuffer(body) && body.length > 0) {
        finish(body, 'pre-parsed Buffer');
        return;
      }
      // Path 2: middleware parsed JSON with a base64 field.
      if (
        body &&
        typeof body === 'object' &&
        typeof (body as { fileBase64?: unknown }).fileBase64 === 'string'
      ) {
        const b64 = (body as { fileBase64: string }).fileBase64;
        try {
          const decoded = Buffer.from(b64, 'base64');
          finish(decoded, `JSON.fileBase64 (${b64.length} chars)`);
        } catch (err) {
          res.status(400).json({ error: `bad base64: ${(err as Error).message}` });
        }
        return;
      }
      // Path 3: raw stream collection.
      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > MAX) {
          aborted = true;
          if (!res.headersSent) {
            res.status(413).json({ error: 'Upload exceeds 100 MB cap' });
          }
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted || res.headersSent) return;
        finish(Buffer.concat(chunks), 'raw stream');
      });
      req.on('error', (err: Error) => {
        if (!res.headersSent) res.status(500).json({ error: err.message });
      });
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

    // Diagnostics — visible in the Node-RED log so a "no project data"
    // warning has context next to it. Logged at info level (not debug) so
    // it shows up in the default log without changing the runtime log level.
    self.log(
      `[knxip] config load: parsedEntries length=${def.parsedEntries?.length ?? 0}, csvData length=${def.csvData?.length ?? 0}, source=${def.source ?? '?'}`,
    );

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
