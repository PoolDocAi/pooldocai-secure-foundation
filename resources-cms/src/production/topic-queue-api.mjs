import {randomUUID} from 'node:crypto';
import {validateTopicRequest} from './topic-to-article.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow'}});
const reject=(error,status=422)=>{throw Object.assign(new Error(error),{status});};
async function readInput(req){
  const text=await req.text();
  if(Buffer.byteLength(text,'utf8')>4096)reject('Request too large',413);
  try {
    const data=text?JSON.parse(text):{};
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
    return data;
  }catch{reject('Invalid request body');}
}
const message=error=>error?.status===429?'AI usage limit reached':
  error?.status===409?'This topic changed; reload the queue':
  error?.status===422?'The generated article did not pass validation; no incomplete draft was saved':
  error?.status===503?'Article generator is unavailable or the research lacked reliable citations':
  'The topic request could not be completed';

export async function handleTopicApi({request,db,user,role,topicPipeline}) {
  const url=new URL(request.url),path=url.pathname;
  if(!topicPipeline?.queueEnabled)return response({error:'Topic queue is not yet enabled in private Staging'},503);
  if(role!=='owner')return response({error:'Owner required'},403);
  try{
    if(path==='/api/topics'){
      if(request.method==='GET')return response(await db.topicList(user));
      if(request.method!=='POST')return response({error:'Method not allowed'},405);
      const input=await readInput(request),topic=validateTopicRequest(input);
      const brief=typeof input.brief==='string'?input.brief.trim():'';
      if(brief.length>1200)reject('Topic notes must be 1200 characters or fewer');
      const item=await db.topicCommand(user,'add',randomUUID(),0,{...topic,brief});
      return response(item,201);
    }
    const m=/^\/api\/topics\/([a-f0-9-]{36})\/(create-article|archive|recover)$/i.exec(path);
    if(!m||!UUID.test(m[1]))return response({error:'Not found'},404);
    if(request.method!=='POST')return response({error:'Method not allowed'},405);
    const [,id,action]=m,input=await readInput(request);
    const list=await db.topicList(user),item=list.find(x=>x.id===id);
    if(!item)return response({error:'Topic not found'},404);
    if(!Number.isInteger(input.version)||input.version!==item.version)return response({error:'Reload changed topic'},409);
    if(action==='archive'){
      if(item.status==='generating')return response({error:'Generation is in progress'},409);
      return response(await db.topicCommand(user,'archive',id,item.version));
    }
    if(action==='recover'){
      if(item.status!=='generating')return response({error:'Topic is not in progress'},409);
      return response(await db.topicCommand(user,'retry',id,item.version));
    }
    if(item.status==='drafted'){
      const row=await db.read(user,item.articleId);
      return response({topic:item,articleId:item.articleId,article:row,state:'drafted'});
    }
    if(item.status!=='queued')return response({error:'Topic is already generating'},409);
    if(!topicPipeline.generator)return response({error:'The server-side AI generator has not been configured'},503);
    const cats=await db.taxonomy(user);
    const category=cats.find(c=>c.kind==='category'&&!c.archived&&
      /(pool care|water|maintenance|chemistry)/i.test(c.name))||
      cats.find(c=>c.kind==='category'&&!c.archived);
    if(!category)return response({error:'Create an active category before generating articles'},422);
    // The DB transition is a row-locked claim, preventing duplicate paid calls.
    const claimed=await db.topicCommand(user,'claim',id,item.version);
    let persisted=false;
    try{
      let row=null;
      try{row=await db.read(user,claimed.articleId);}catch(e){if(e.status!==404)throw e;}
      if(!row){
        const generated=await topicPipeline.generator({
          topic:item.topic,audience:item.audience,brief:item.brief,categoryId:category.id
        });
        // Unique planned article ID is reserved when topic enters the queue.
        // Never overwrite a pre-existing or owner-approved article.
        const article={...generated.article,
          slug:generated.article.slug.slice(0,107)+'-'+id.slice(0,8),
          seo:{...generated.article.seo,noindex:true},
          featured:false,publishedAt:null};
        await db.command(user,claimed.articleId,0,'create',article,claimed.articleId);
        persisted=true;
      }else{
        if(row.state!=='draft')reject('Only private drafts can be associated with topics',409);
        persisted=true;
      }
      const completed=await db.topicCommand(user,'complete',id,claimed.version);
      return response({topic:completed,articleId:claimed.articleId,reviewRequired:true,state:'drafted'},201);
    }catch(error){
      if(!persisted){
        try{await db.topicCommand(user,'release',id,claimed.version);}catch{}
      }
      throw error;
    }
  }catch(error){
    const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:500;
    return response({error:message(error)},status);
  }
}
