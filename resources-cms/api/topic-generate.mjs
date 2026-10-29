import { createHandler } from './resources.mjs';

// Dedicated, longer-running route for a single owner-reviewed article creation.
// All identity, Origin/CSRF, JWT membership and durable DB claim checks continue
// through the original application handler. This wrapper is NOT an auth bypass.
const topicCreatePath=/^\/api\/topics\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/create-article$/i;

export function createTopicGenerationHandler({ delegate=createHandler() }={}) {
  if(typeof delegate!=='function')throw new TypeError('CMS handler required');
  return async (req,res)=>{
    let route;
    try{
      const url=new URL(req.url||'/', 'https://cms.invalid');
      route=url.pathname==='/api/topic-generate'&&url.searchParams.getAll('__cms_path').length===1
        ? url.searchParams.get('__cms_path') : null;
    }catch{route=null;}
    if(req.method!=='POST'||!route||!topicCreatePath.test(route)){
      res.statusCode=404;
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({error:'Not found'}));
      return;
    }
    return delegate(req,res);
  };
}

export default createTopicGenerationHandler();
