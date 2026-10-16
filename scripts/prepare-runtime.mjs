// Desktop backend code and SQLite are compiled into Weave.exe. This command
// deliberately has no dependency installation or production-runtime copying.
import fs from 'node:fs/promises';
import path from 'node:path';
import {ROOT} from '../app/weave/build.mjs';
const desktop = path.join(ROOT,'dist/desktop/index.html');
await fs.access(desktop);
// Export workspace embeds this reader template at compile time (src-tauri/build.rs).
if(!(await fs.readFile(path.join(ROOT,'dist/export-template.html'),'utf8')).includes('"__WEAVE_EXPORT_DATA__"'))throw new Error('dist/export-template.html is missing its data placeholder. Run npm run build:desktop.');
const output=path.resolve(ROOT,'dist/runtime'), parent=await fs.realpath(path.join(ROOT,'dist'));
if(path.dirname(output)!==path.resolve(ROOT,'dist') || parent!==path.resolve(ROOT,'dist'))throw new Error('Unsafe generated runtime cleanup path');
const stat=await fs.lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;});
if(stat?.isSymbolicLink())throw new Error('Refusing to remove a linked runtime directory');
if(stat)await fs.rm(output,{recursive:true,force:true});
await fs.writeFile(path.join(ROOT,'dist/native-build.json'),JSON.stringify({backend:'rust',database:'sqlite-fts5',runtimeFiles:[],frontend:'embedded',exportTemplate:'embedded'},null,2));
console.log('Native assets ready. Weave.exe embeds its frontend and Rust/SQLite backend; no Node runtime is packaged.');
