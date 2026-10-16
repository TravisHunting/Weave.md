import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['--test','app/weave/tests/git.test.mjs'],{stdio:'inherit',windowsHide:true,env:{...process.env,WEAVE_TEST_GIT:'rust'}});
child.on('exit',code=>process.exitCode=code ?? 1);
