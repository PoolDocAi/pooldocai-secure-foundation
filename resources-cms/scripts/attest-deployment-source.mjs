// Offline comparison of Vercel upload SHA-1 identifiers with committed bytes.
// This is source correspondence evidence, not proof of the compiled runtime.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [inventory,revision,output]=process.argv.slice(2);
if(!inventory || !/^[a-f0-9]{40}$/.test(revision||'') || !output) throw Error('Usage: inventory.json full-commit-sha report.json');
const source=JSON.parse(readFileSync(inventory,'utf8'));
const rows=source.files.map(file=>{
 if(!/^(src\/|public\/|api\/|config\/|package(?:-lock)?\.json$|vercel\.json$)/.test(file.path)||file.path.split('/').some(x=>x==='..'||x==='.'||x==='')) throw Error('Unexpected source path');
 if(!/^[a-f0-9]{40}$/.test(file.uid))throw Error('Unexpected upload identifier');
 try {
  const bytes=execFileSync('git',['show',`${revision}:resources-cms/${file.path}`],{stdio:['ignore','pipe','pipe']});
  const sha1=createHash('sha1').update(bytes).digest('hex');
  return {path:file.path,deployedSha1:file.uid,committedSha1:sha1,status:sha1===file.uid?'match':'different'};
 } catch {return {path:file.path,status:'missing-in-commit',deployedSha1:file.uid};}
});
const report={deploymentId:source.deploymentId,revision,observedAt:source.observedAt,scope:'Selected uploaded source files; excludes private catalog, build output, dependencies and environment settings',matches:rows.filter(x=>x.status==='match').length,total:rows.length,attested:rows.every(x=>x.status==='match'),rows};
writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({deploymentId:report.deploymentId,revision,matches:report.matches,total:report.total,attested:report.attested,differences:rows.filter(x=>x.status!=='match').map(x=>x.path)}));
