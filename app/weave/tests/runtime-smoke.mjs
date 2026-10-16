// Native portable acceptance replaces the retired sidecar smoke test. The
// verification copies only Weave.exe and launches it with an empty PATH.
import path from 'node:path';
import {ROOT} from '../build.mjs';
process.argv[2] ||= path.join(process.env.CARGO_TARGET_DIR || path.join(ROOT,'src-tauri/target'),'debug',process.platform === 'win32' ? 'weave.exe' : 'weave');
await import('../verify-native.mjs');
