// eelectron-knxip-ets-config — config node holding a parsed ETS project map.
// Each instance owns its own ETSProjectMap; multiple ETS configs can coexist
// (e.g. different sites/projects) just like the tunnel config nodes.

import type { Node, NodeAPI, NodeDef } from 'node-red';
import { ETSProjectMap } from '../../ets/projectMap';
import { getDpt, listDpts } from '../../dpt';
import type { KnxEtsConfigNode } from '../shared/configNode';

interface ETSConfigProps {
  /** Raw CSV content stored alongside the node config (uploaded or pasted). */
  csvData?: string;
  /** Hint for the user about how the source was loaded; not used at runtime. */
  csvSource?: 'upload' | 'paste' | 'unknown';
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
      const id = typeof rawId === 'string' ? rawId : Array.isArray(rawId) ? String(rawId[0] ?? '') : '';
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
  // Editor uses this for typeahead in DPT fields. The list is global so it
  // doesn't depend on a specific config node.
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

  function EtsConfigCtor(this: Node & KnxEtsConfigNode, def: Def) {
    RED.nodes.createNode(this, def);
    const self = this;
    const map = new ETSProjectMap();
    self.map = map;
    self.entryCount = 0;

    if (def.csvData && def.csvData.trim()) {
      try {
        const result = map.loadCsv(def.csvData);
        self.entryCount = result.entries;
        if (result.warnings.length > 0) {
          self.warn(
            `ETS CSV parsed with ${result.warnings.length} warning(s): ${result.warnings.slice(0, 3).join('; ')}${result.warnings.length > 3 ? '…' : ''}`,
          );
        }
        if (result.unknownDpt.length > 0) {
          self.warn(
            `ETS: ${result.unknownDpt.length} group addresses use a DPT not in our codec library`,
          );
        }
        self.log(
          `ETS project loaded: ${result.entries} group addresses (${result.withDpt} with known DPT)`,
        );
      } catch (err) {
        self.error(`Failed to parse ETS CSV: ${(err as Error).message}`);
      }
    } else {
      self.warn('ETS config has no CSV data — translator nodes will pass-through');
    }
  }

  RED.nodes.registerType(
    'eelectron-knxip-ets-config',
    EtsConfigCtor as unknown as () => void,
  );
};
