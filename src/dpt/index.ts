// Re-export the registry surface and trigger registration of every codec module.
// Importing `./dpt1`, `./dpt5`, etc. for their side effects is what populates
// the registry — consumers get the codecs by simply importing this module.

import './dpt1';
import './dpt2';
import './dpt3';
import './dpt4';
import './dpt5';
import './dpt6';
import './dpt7';
import './dpt8';
import './dpt9';
import './dpt10';
import './dpt11';
import './dpt12';
import './dpt13';
import './dpt14';
import './dpt16';
import './dpt17';
import './dpt18';
import './dpt19';
import './dpt20';
import './dpt26';
import './dpt28';
import './dpt29';
import './dpt232';
import './dpt235';
import './dpt251';

export { type DPTCodec, getDpt, hasDpt, listDpts, registerDpt } from './registry';
