import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {PrivateStorage,validatedImage,mediaGateway,mediaObjectKey,MAX_IMAGE_BYTES} from '../src/production/storage.mjs';

const first='00000000-0000-4000-8000-000000000001';
const second='00000000-0000-4000-8000-000000000002';
// Synthetic raster pixels are nonpersistent security-test fixtures only. They
// are never article imagery or placed in a public resource catalog.
const fixture=()=>sharp({create:{width:8,height:6,channels:3,background:'#007b91'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'Test-only metadata'}}}).toBuffer();

test('real image decoder re-encodes canonical WebP and removes source metadata',async()=>{
 const image=await validatedImage(await fixture());
 const metadata=await sharp(image.bytes).metadata();
 assert.equal(image.mime,'image/webp');assert.equal(metadata.format,'webp');
 assert.equal(metadata.width,8);assert.equal(metadata.height,6);assert.equal(metadata.exif,undefined);
 assert.equal(image.checksum,createHash('sha256').update(image.bytes).digest('hex'));
 assert.equal((await validatedImage(await fixture())).checksum,image.checksum);
});

test('SVG, PDF, malformed and oversized input stay disabled',async()=>{
 for(const bytes of[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'),Buffer.from('%PDF-1.7\nnot-safe'),Buffer.from('not an image'),Buffer.alloc(MAX_IMAGE_BYTES+1)])await assert.rejects(validatedImage(bytes));
});

test('adapter forwards only caller token and canonical bytes without overwriting objects',async()=>{
 const calls=[];const adapter=new PrivateStorage({url:'https://staging.example.supabase.co',publishableKey:'sb_publishable_test',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(null,{status:200});}});
 await adapter.upload(first,'verified-owner-token',await fixture());
 await adapter.upload(second,'verified-owner-token',await fixture());
 assert.notEqual(calls[0].url,calls[1].url); // Replacements get a fresh media ID.
 assert.equal(calls[0].options.headers.Authorization,'Bearer verified-owner-token');
 assert.equal(calls[0].options.headers.apikey,'sb_publishable_test');
 assert.equal(calls[0].options.headers['Content-Type'],'image/webp');
 assert.equal(calls[0].options.headers['x-upsert'],'false');
 assert.equal((await sharp(calls[0].options.body).metadata()).format,'webp');
 await adapter.remove(first,'verified-owner-token');assert.equal(calls.at(-1).options.method,'DELETE');
 assert.equal(calls.at(-1).options.headers['x-upsert'],undefined);
});

test('missing authentication, malformed keys, unsafe methods and header injection never reach Storage',async()=>{
 let calls=0;const adapter=new PrivateStorage({url:'https://staging.example.supabase.co',publishableKey:'public',fetchImpl:async()=>{calls++;return new Response();}});
 await assert.rejects(adapter.download(first,null),/Authentication/);
 for(const key of['images/------------------------------------.webp','images/../secret.webp','tenant-private/manual.pdf'])await assert.rejects(adapter.request(key,'owner'),/object key/);
 await assert.rejects(adapter.request(mediaObjectKey(first),null,{method:'DELETE',allowAnonymous:true}),/operation/);
 await assert.rejects(adapter.request(mediaObjectKey(first),'owner\r\nsecret'),/Authentication/);
 await assert.rejects(adapter.request(mediaObjectKey(first),'owner',{method:'PUT'}),/operation/);
 assert.equal(calls,0);
});

test('Storage provider denials fail closed and public gateway never downloads an unauthorized ID',async()=>{
 const adapter=new PrivateStorage({url:'https://staging.example.supabase.co',publishableKey:'public',fetchImpl:async()=>new Response(null,{status:403})});
 await assert.rejects(adapter.download(first,'unauthorized-token'),/rejected/);
 let reads=0;const denied=await mediaGateway(first,{authorize:async()=>false,readPrivate:async()=>{reads++;return Buffer.from('x');}});
 assert.equal(denied.status,404);assert.equal(denied.headers.get('cache-control'),'no-store');assert.equal(reads,0);
});

test('public image revocation is rechecked on the next request with no stale cache window',async()=>{
 const image=await validatedImage(await fixture());let allowed=true,reads=0;
 const options={published:true,etag:image.checksum,authorize:async()=>allowed,readPrivate:async()=>{reads++;return image.bytes;}};
 const published=await mediaGateway(first,options);assert.equal(published.status,200);
 assert.match(published.headers.get('cache-control'),/no-store/);
 assert.doesNotMatch(published.headers.get('cache-control'),/stale-while-revalidate/);
 assert.equal(published.headers.get('content-type'),'image/webp');
 assert.equal(published.headers.get('x-content-type-options'),'nosniff');
 allowed=false;const withdrawn=await mediaGateway(first,options);
 assert.equal(withdrawn.status,404);assert.equal(reads,1);
 const draft=await mediaGateway(second,{authorize:async()=>true,readPrivate:async()=>image.bytes});assert.equal(draft.headers.get('cache-control'),'private, no-store');
});
