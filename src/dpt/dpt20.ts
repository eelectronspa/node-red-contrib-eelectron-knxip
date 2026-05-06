// DPT 20.* — 1-byte enumerated value (HVAC modes, fan speed, etc.).
// We keep the raw 0..255 number so users can pattern-match on the value;
// downstream nodes can map to human names if they wish.
//
// Common sub-types:
//   20.102 HVAC Mode             (0=auto, 1=comfort, 2=standby, 3=economy, 4=building_protection)
//   20.103 DHW Mode              (0=auto, 1=legio_protect, 2=normal, 3=reduced, 4=off_or_frost_protect)
//   20.104 Load Priority         (0=none, 1=shift_load_priority, 2=absolute_load_priority)
//   20.105 HVAC Controller Mode  (0=auto, 1=heat, 3=cool, 9=fan_only, ...)

import type { APDUValue } from '../core/apci';
import { ConversionError } from '../core/errors';
import { type DPTCodec, registerDpt } from './registry';

function makeEnum8(id: string, name: string): DPTCodec<number> {
  return {
    id,
    name,
    decode(apdu: APDUValue): number {
      if (apdu.kind !== 'bytes' || apdu.value.length !== 1) {
        throw new ConversionError(`DPT ${id}: expected 1-byte APDU`);
      }
      return apdu.value[0]!;
    },
    encode(value: number): APDUValue {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new ConversionError(`DPT ${id}: value must be integer 0..255, got ${value}`);
      }
      return { kind: 'bytes', value: Buffer.from([value]) };
    },
  };
}

registerDpt(makeEnum8('20.102', 'hvac_mode'));
registerDpt(makeEnum8('20.103', 'dhw_mode'));
registerDpt(makeEnum8('20.104', 'load_priority'));
registerDpt(makeEnum8('20.105', 'hvac_controller_mode'));
registerDpt(makeEnum8('20.108', 'occupancy_mode'));
registerDpt(makeEnum8('20.109', 'priority'));
registerDpt(makeEnum8('20.110', 'light_application_mode'));
registerDpt(makeEnum8('20.111', 'application_area'));
registerDpt(makeEnum8('20.112', 'alarm_class_type'));
