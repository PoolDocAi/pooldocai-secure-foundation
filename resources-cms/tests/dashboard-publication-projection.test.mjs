import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibilityRoute} from '../src/production/compat-api.mjs';

const ID1='00000000-0000-4000-8000-000000000021';
const ID2='00000000-0000-4000-8000-000000000022';
const ID3='00000000-0000-4000-8000-000000000023';
const article=(id,slug,state,published)=>({id,slug,state,
  published_revision_id:published?'00000000-0000-4000-8000-000000000099':null,
  editable:{title:slug,slug,summary:'Private CMS summary',body:'<p>Safe text</p>',
    seo:{title:slug,description:'Accurate metadata'},sources:[]}
});
function fixture() {
 const data={
  rows:[
    article(ID1,'green-pool-first-checks','draft',false),
    article(ID2,'pool-pump-wont-start','draft',true),
    article(ID3,'blocked-article','published',true)
  ],
  publiclyAccessible:[{article_id:ID2,slug:'pool-pump-wont-start'}],
  fail:false
 };
 const db={
  list:async()=>structuredClone(data.rows),
  publicIndex:async()=>{if(data.fail)throw Error('Public RPC unavailable');return structuredClone(data.publiclyAccessible);},
  recentAudit:async()=>[]
 };
 const route=compatibilityRoute({db,
  identity:async()=>({id:ID1,accessToken:'synthetic-test-token'}),
  memberRole:async()=> 'owner',origin:'https://cms.example'});
 const get=()=>route(new Request('https://cms.example/api/dashboard'));
 return {data,get};
}

test('dashboard counts the actually delivered CMS revision, not its mutable draft state',async()=>{
 const {data,get}=fixture();
 const response=await get();assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 const body=await response.json();
 assert.equal(body.counts.published,1);
 assert.equal(body.counts.draft,2);
 assert.deepEqual(body.publicArticleIds,[ID2]);
 // A published state with a blocked pointer does not count as delivered.
 assert.equal(body.publicArticleIds.includes(ID3),false);
 // Unpublishing the active revision revokes projection access immediately.
 data.publiclyAccessible=[];
 const removed=await (await get()).json();
 assert.equal(removed.counts.published,0);
 assert.deepEqual(removed.publicArticleIds,[]);
});

test('failed CMS publication projection never reports a misleading zero',async()=>{
 const {data,get}=fixture();
 data.fail=true;
 const response=await get();assert.equal(response.status,500);
 const body=await response.json();
 assert.equal(body.counts,undefined);
 assert.equal(body.publicArticleIds,undefined);
 assert.doesNotMatch(JSON.stringify(body),/Public RPC unavailable/);
});
