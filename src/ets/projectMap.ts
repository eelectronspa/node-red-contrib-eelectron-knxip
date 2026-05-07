// In-memory map of an ETS project's group addresses.
// Keyed by raw uint16 (so all GA notation styles match the same entry).

import { GroupAddress } from '../core/address';
import { parseEtsCsv } from './csvParser';
import { normalizeDptId } from './dptNormalize';
import {
  type KnxprojGroupAddress,
  type ParseKnxprojOptions,
  parseKnxproj,
} from './knxproj';

export interface ETSEntry {
  /** Original GA string, e.g. "1/2/3". */
  ga: string;
  /** Raw uint16 form of the address. */
  raw: number;
  /** Normalized DPT id if known and registered (e.g. "1.001"), else null. */
  dpt: string | null;
  /** Original DPT string from the CSV (DPST-1-1, DPT-9.001, ...). */
  dptRaw: string | null;
  /** GA name (from the CSV "Name"/"Description" column). */
  name: string;
  /** Free-form comment column. */
  description: string;
}

export interface ETSLoadResult {
  entries: number;
  withDpt: number;
  unknownDpt: { ga: string; dptRaw: string }[];
  warnings: string[];
}

export class ETSProjectMap {
  private readonly byRaw = new Map<number, ETSEntry>();

  size(): number {
    return this.byRaw.size;
  }

  get(ga: GroupAddress | string | number): ETSEntry | null {
    const raw = ga instanceof GroupAddress ? ga.raw : new GroupAddress(ga).raw;
    return this.byRaw.get(raw) ?? null;
  }

  list(): ETSEntry[] {
    return [...this.byRaw.values()];
  }

  loadCsv(csv: string): ETSLoadResult {
    this.byRaw.clear();
    const { rows, warnings } = parseEtsCsv(csv);
    const unknownDpt: { ga: string; dptRaw: string }[] = [];
    let withDpt = 0;
    for (const row of rows) {
      let raw: number;
      try {
        raw = new GroupAddress(row.ga).raw;
      } catch (err) {
        warnings.push(`Skipped "${row.ga}": ${(err as Error).message}`);
        continue;
      }
      const norm = normalizeDptId(row.dpt);
      const entry: ETSEntry = {
        ga: row.ga,
        raw,
        dpt: norm?.registered ? norm.id : null,
        dptRaw: row.dpt,
        name: row.name,
        description: row.description,
      };
      if (entry.dpt) withDpt += 1;
      else if (row.dpt) unknownDpt.push({ ga: row.ga, dptRaw: row.dpt });
      this.byRaw.set(raw, entry);
    }
    return {
      entries: this.byRaw.size,
      withDpt,
      unknownDpt,
      warnings,
    };
  }

  /** Load directly from a .knxproj archive buffer (optionally password-protected). */
  loadKnxproj(
    buffer: Buffer,
    opts: ParseKnxprojOptions = {},
  ): ETSLoadResult & { projectName: string | null } {
    const { groupAddresses, projectName, warnings } = parseKnxproj(buffer, opts);
    const result = this.loadParsedEntries(groupAddresses);
    return { ...result, projectName, warnings: [...warnings, ...result.warnings] };
  }

  /**
   * Ingest a pre-parsed list of entries (e.g. produced by the editor's admin
   * endpoint after uploading a .knxproj). Used so we don't have to ship the
   * whole binary archive inside the Node-RED node config.
   */
  loadParsedEntries(entries: KnxprojGroupAddress[]): ETSLoadResult {
    this.byRaw.clear();
    const warnings: string[] = [];
    const unknownDpt: { ga: string; dptRaw: string }[] = [];
    let withDpt = 0;
    for (const e of entries) {
      const norm = normalizeDptId(e.dpt);
      const entry: ETSEntry = {
        ga: e.ga,
        raw: e.raw,
        dpt: norm?.registered ? norm.id : null,
        dptRaw: e.dpt,
        name: e.name,
        description: e.description,
      };
      if (entry.dpt) withDpt += 1;
      else if (e.dpt) unknownDpt.push({ ga: e.ga, dptRaw: e.dpt });
      this.byRaw.set(e.raw, entry);
    }
    return {
      entries: this.byRaw.size,
      withDpt,
      unknownDpt,
      warnings,
    };
  }
}
