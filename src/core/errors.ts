// Common parser errors. Kept separate so any module can throw these without
// importing protocol-specific code.

export class CouldNotParseKNXIP extends Error {
  constructor(message: string) {
    super(`Could not parse KNX/IP frame: ${message}`);
    this.name = 'CouldNotParseKNXIP';
  }
}

export class IncompleteKNXIPFrame extends Error {
  constructor(message: string) {
    super(`Incomplete KNX/IP frame: ${message}`);
    this.name = 'IncompleteKNXIPFrame';
  }
}

export class CouldNotParseCEMI extends Error {
  constructor(message: string) {
    super(`Could not parse CEMI frame: ${message}`);
    this.name = 'CouldNotParseCEMI';
  }
}

/** Semantic errors during APCI/DPT encoding (out-of-range values, type mismatches). */
export class ConversionError extends Error {
  constructor(message: string) {
    super(`Conversion error: ${message}`);
    this.name = 'ConversionError';
  }
}

/**
 * Service identifier the parser doesn't (yet) implement. Distinct from
 * `CouldNotParseKNXIP` so the transport layer can log-and-drop without
 * treating it as a protocol violation — many gateways send DESCRIPTION_RESPONSE
 * or ROUTING_INDICATION on the wire that we simply don't care about for tunneling.
 */
export class UnsupportedKNXIPService extends Error {
  constructor(
    public readonly serviceType: number,
    message?: string,
  ) {
    super(
      message ??
        `Unsupported KNX/IP service type 0x${serviceType.toString(16).padStart(4, '0')}`,
    );
    this.name = 'UnsupportedKNXIPService';
  }
}
