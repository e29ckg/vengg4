import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import { root } from '../src/config.js';

const repo=path.resolve(root,'..'),outputIndex=process.argv.indexOf('--output'),output=path.resolve(outputIndex>=0?process.argv[outputIndex+1]:path.join(repo,'dist'));
const archive=path.join(output,'vengg4-native-windows.zip');
if(!process.argv.includes('--force')&&await fs.stat(archive).catch(()=>null))throw Error('Archive exists. Add --force to replace it.');
const npm=process.env.npm_execpath;if(!npm)throw Error('Run this script using npm run package');
async function command(args,cwd,env=process.env){
  const processHandle=spawn(process.execPath,[npm,...args],{cwd,env,stdio:'inherit',windowsHide:true});
  const exit=await new Promise((resolve,reject)=>{processHandle.once('error',reject);processHandle.once('exit',resolve)});if(exit!==0)throw Error(`npm ${args[0]} failed`);
}
await fs.mkdir(output,{recursive:true});
const stage=await fs.mkdtemp(path.join(output,'.node-build-')),folder=path.join(stage,'vengg4-native'),temporary=path.join(output,`.node-package-${path.basename(stage)}.zip`);
try{
  const {stdout}=await promisify(execFile)('git',['-c','core.quotepath=false','ls-files','--cached','--others','--exclude-standard'],{cwd:repo,maxBuffer:4*1024*1024});
  const sources=[...new Set(stdout.trim().split(/\r?\n/).filter(name=>/^backend-node\/(?:src\/|bin\/|migrations\/|resources\/|package(?:-lock)?\.json$|\.env\.example$)/.test(name)))];
  for(const relative of sources){const destination=path.join(folder,relative);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(repo,relative),destination);}
  for(const file of ['Install-Native.cmd','Start-Native.cmd','README.md','SECURITY_REVIEW_NODE.md','deploy/node-apache.conf','deploy/native/open-web-setup.ps1']){const destination=path.join(folder,file);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(path.join(repo,file),destination);}
  console.log('[1/3] Building frontend for /vengg4/');
  const frontend=path.join(repo,'frontend');
  if(!await fs.stat(path.join(frontend,'node_modules')).catch(()=>null))await command(['ci'],frontend);
  await command(['run','build','--','--base=/vengg4/'],frontend,{...process.env,VITE_API_BASE_URL:'/vengg4/api/'});
  await fs.mkdir(path.join(folder,'frontend'),{recursive:true});
  await fs.cp(path.join(frontend,'dist'),path.join(folder,'frontend/dist'),{recursive:true});
  console.log('[2/3] Bundling Node production dependencies');
  await command(['ci','--omit=dev','--no-audit','--no-fund'],path.join(folder,'backend-node'));
  console.log('[3/3] Creating Node installer ZIP');
  const zip=new yazl.ZipFile();
  async function add(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await add(file);else if(entry.isFile())zip.addFile(file,path.relative(stage,file).split(path.sep).join('/'));
  }}
  await add(folder);const done=pipeline(zip.outputStream,createWriteStream(temporary));zip.end();await done;
  await fs.rename(temporary,archive);
  const checksum=createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(`${archive}.sha256`,`${checksum}  ${path.basename(archive)}\n`);
  console.log(`Created: ${archive}\nSHA256: ${checksum}`);
}finally{
  const resolved=await fs.realpath(stage),parent=await fs.realpath(output);
  if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase()||!path.basename(resolved).startsWith('.node-build-'))throw Error('Unsafe package cleanup path');
  await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:1000});
  await fs.unlink(temporary).catch(()=>{});
}
