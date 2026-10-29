import {isIP} from 'node:net';

// Citation links only: this pipeline never fetches source URLs or redirects.
export function validResearchUrl(value) {
  if(typeof value!=='string'||value.length>2048)return false;
  try {
    const u=new URL(value),host=u.hostname.toLowerCase();
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&
      !isIP(host)&&!host.includes(':')&&host.includes('.')&&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)&&
      !host.endsWith('.')&&/^[a-z0-9.-]+$/.test(host);
  }catch{return false;}
}
