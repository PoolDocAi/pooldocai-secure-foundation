// New RPCs remain unavailable until separately reviewed migration/config gates.
// Uses only existing publishable key + verified caller JWT; no privileged key.
export class SupabasePlatformAdapter {
 constructor(cms){this.cms=cms;}
 rpc(name,user,payload={}){return this.cms.rpc(name,payload,user?.accessToken);}
 facets(user){return this.rpc('facet_query',user);}
 command(user,input){return this.rpc('facet_command',user,{p_command:input});}
 requestTag(user,input){return this.rpc('facet_request',user,{p_request:input});}
 tagRequests(user){return this.rpc('facet_requests',user);}
 catalog(){return this.rpc('verified_public_catalog',null);}
 collect(events,context){return this.rpc('analytics_collect',null,{p_events:events,p_gpc:context.gpc,p_bot:context.bot});}
 report(user,filter){return this.rpc('analytics_report',user,{p_filter:filter});}
 purge(user,before){return this.rpc('analytics_purge',user,{p_before:before});}
}
