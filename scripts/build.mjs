import {spawn} from 'node:child_process';
import path from 'node:path';
const npm=process.env.npm_execpath;
if(!npm)throw Error('Run npm run build from the project root');
const child=spawn(process.execPath,[npm,'run','build','--','--base=/vengg4/'],{
  cwd:path.resolve(import.meta.dirname,'../frontend'),
  env:{...process.env,VITE_API_BASE_URL:'/vengg4/api/'},stdio:'inherit',windowsHide:true,
});
child.on('error',error=>{console.error(error.message);process.exitCode=1});
child.on('exit',code=>{process.exitCode=code??1});
