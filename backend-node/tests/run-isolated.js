import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { once } from 'node:events';

const executable = process.env.TEST_MYSQLD;
if (!executable) throw Error('Set TEST_MYSQLD to the MariaDB mysqld.exe path; mysql_install_db.exe must be beside it');
const initializer = path.join(path.dirname(executable),'mysql_install_db.exe');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(),'vengg4-node-test-'));
const rootPassword = randomBytes(24).toString('hex');
const listener = net.createServer(); await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
let database, child;
try {
  const datadir = path.join(fixture,'data');
  await promisify(execFile)(initializer,[`--datadir=${datadir}`,`--password=${rootPassword}`,`--port=${port}`],{ timeout: 120000,windowsHide: true });
  const log = createWriteStream(path.join(fixture,'database.log')); await once(log,'open');
  database = spawn(executable,[`--defaults-file=${path.join(datadir,'my.ini')}`,`--datadir=${datadir}`,`--port=${port}`,'--bind-address=127.0.0.1','--skip-log-bin','--console',`--pid-file=${path.join(fixture,'database.pid')}`],{ stdio: ['ignore',log,log],windowsHide: true });
  let ready = false;
  for (let i=0;i<120;i++) {
    try { const connection = await mysql.createConnection({ host:'127.0.0.1',port,user:'root',password:rootPassword }); await connection.end(); ready=true;break; }
    catch { if (database.exitCode !== null) throw new Error('Isolated database exited; see fixture log'); await new Promise(resolve=>setTimeout(resolve,500)); }
  }
  if (!ready) throw new Error('Isolated database did not start');
  const directory = path.resolve(import.meta.dirname,'..');
  child = spawn(process.execPath,['--test',...((await fs.readdir(path.join(directory,'tests/integration'))).filter(name=>name.endsWith('.test.js')).map(name=>path.join(directory,'tests/integration',name)))],{
    cwd: directory,stdio:'inherit',windowsHide:true,env:{ ...process.env,TEST_DB_HOST:'127.0.0.1',TEST_DB_PORT:String(port),TEST_DB_USER:'root',TEST_DB_PASS:rootPassword,TEST_FIXTURE_ROOT:fixture },
  });
  const exitCode = await new Promise(resolve=>child.once('exit',resolve));
  if (exitCode !== 0) process.exitCode=exitCode || 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  if (database && database.exitCode === null) {
    try { const connection=await mysql.createConnection({host:'127.0.0.1',port,user:'root',password:rootPassword}); await connection.query('SHUTDOWN'); connection.destroy(); } catch { database.kill(); }
    if(database.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,10000);database.once('exit',()=>{clearTimeout(timer);resolve()})});
  }
  const resolved = await fs.realpath(fixture), expected = await fs.realpath(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== expected.toLowerCase() || !path.basename(resolved).startsWith('vengg4-node-test-')) throw new Error('Unsafe fixture cleanup path');
  await fs.rm(resolved,{ recursive:true,force:true,maxRetries:5,retryDelay:1000 });
}
