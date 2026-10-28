// Supabase Auth MFA: TOTP and SMS phone factors. AAL1 pending sessions cannot reach CMS data or administrative routes.
// Uses only the publishable key; secrets never enter logs or storage outside Supabase.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError, parseCookies, CSRF_COOKIE, clearSessionCookies, sessionCookies, verifiedIdentity, requireOrigin, requireCsrf, sessionToken } from './auth.mjs';

export const PENDING_COOKIE='__Host-pooldocai-cms-mfa-pending';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore={'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const cookie=(name,value,maxAge,httpOnly=true)=>`${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}${httpOnly?'; HttpOnly':''}`;

export function aal2Required(token, identity){
  // Supabase /auth/v1/user must have already authenticated this same bearer.
  if (!token || !identity?.id) throw new AuthError('MFA required',403);
  try {
    const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
    if(claims.sub!==identity.id||claims.aal!=='aal2'||!Number.isFinite(claims.exp)||claims.exp<=Date.now()/1000)
      throw new AuthError('MFA verification required',403);
  } catch(error) {if(error instanceof AuthError)throw error;throw new AuthError('MFA verification required',403)}
  return identity;
}

export function pendingCookies(accessToken){
  if(!accessToken||accessToken.length>8192)throw new AuthError('Invalid pending authentication',401);
  const csrf=randomBytes(32).toString('base64url');
  return {csrf,headers:[...clearSessionCookies(),
    cookie(PENDING_COOKIE,accessToken,300),
    cookie(CSRF_COOKIE,csrf,300,false)]};
}
export function clearPendingCookie(){return cookie(PENDING_COOKIE,'',0)}
export function pendingToken(request) {
  const value=parseCookies(request.headers.get('cookie'))[PENDING_COOKIE];
  if(!value||value.length>8192)throw new AuthError('MFA session expired',401);
  return value;
}

async function gotrue(path,token,config,{method='GET',body,fetchImpl=fetch}={}){
  const response=await fetchImpl(new URL(path,config.url),{
    method,headers:{apikey:config.publishableKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)
  });
  if(!response.ok) throw new AuthError('Verification rejected',response.status===429?429:403);
  return response.json();
}
// Return sanitized factor choices; never expose the owner's full phone number.
export async function verifiedFactors(token,config,options={}){
  const data=await gotrue('/auth/v1/factors',token,config,{fetchImpl:config.fetchImpl||fetch,...options});
  const rows=Array.isArray(data)?data:[
    ...(Array.isArray(data.totp)?data.totp:[]),
    ...(Array.isArray(data.phone)?data.phone:[]),
    ...(Array.isArray(data.factors)?data.factors:[])
  ];
  const seen=new Set();
  return rows.filter(x=>{
    if(x.status!=='verified'||!UUID.test(String(x.id||''))||seen.has(x.id))return false;
    if(!['totp','phone'].includes(x.factor_type||x.type))return false;
    seen.add(x.id);return true;
  }).map(x=>({
    id:x.id, type:(x.factor_type||x.type),
    name: typeof x.friendly_name==='string'&&x.friendly_name.length<=80
      ?x.friendly_name:((x.factor_type||x.type)==='phone'?'Text message':'Authenticator')
  }));
}

const E164=/^\\+[1-9][0-9]{7,14}$/;

const json=(body,status=200,cookies=[])=>{
  const headers=new Headers({'Content-Type':'application/json',...noStore});
  for(const v of cookies)headers.append('Set-Cookie',v);
  return new Response(JSON.stringify(body),{status,headers});
};
async function requestBody(request){
  const text=await request.text();
  if(Buffer.byteLength(text)>2000)throw new AuthError('Invalid MFA request',413);
  try{return JSON.parse(text)}catch{throw new AuthError('Invalid MFA request',422)}
}

export function mfaRoute({origin,authConfig,memberRole,allowPreEnrollment=false,fetchImpl=fetch}){
  return async(request)=>{
    try{
      if(request.method!=='POST')return json({error:'Method not allowed'},405);
      requireOrigin(request,origin);
      requireCsrf(request);
      const pathname=new URL(request.url).pathname;
      if(!['/api/mfa/enroll','/api/mfa/challenge','/api/mfa/verify'].includes(pathname)) return json({error:'Not found'},404);
      // Only the short-lived AAL1 pending cookie or an already AAL2 owner session is accepted.
      let token,temporary=true;
      try{token=pendingToken(request)}
      catch{token=sessionToken(request);temporary=false}
      const user=await verifiedIdentity(token,{...authConfig,fetchImpl});
      const role=await memberRole({...user,accessToken:token});
      if(!temporary){if(role!=='owner')throw new AuthError('Owner required',403);if(!allowPreEnrollment)aal2Required(token,user)}
      const body=await requestBody(request);
      if(pathname==='/api/mfa/enroll'){
        const existing=await verifiedFactors(token,authConfig,{fetchImpl});
        if(temporary&&existing.length)throw new AuthError('Use existing verified factor',403);
        const type=body.type==='phone'?'phone':body.type==='totp'?'totp':null;
        if(!type)throw new AuthError('Invalid factor type',422);
        const phone=String(body.phone||'').trim();
        if(type==='phone'&&!E164.test(phone))throw new AuthError('Invalid phone format',422);
        const payload=type==='phone'
          ?{factor_type:'phone',phone,friendly_name:'PoolDocAI Studio SMS'}
          :{factor_type:'totp',friendly_name:temporary?'PoolDocAI Studio':'PoolDocAI Studio backup'};
        const result=await gotrue('/auth/v1/factors',token,authConfig,{
          method:'POST',body:payload,fetchImpl
        });
        if(!UUID.test(String(result.id||'')))throw new AuthError('Enrollment unavailable',503);
        if(type==='phone')return json({factorId:result.id,type:'phone',delivery:'sms'});
        if(!result.totp?.qr_code)throw new AuthError('Enrollment unavailable',503);
        return json({factorId:result.id,type:'totp',qrCode:result.totp.qr_code});
      }
      if(pathname==='/api/mfa/challenge'){
        if(!UUID.test(String(body.factorId||'')))throw new AuthError('Invalid factor',422);
        // Supabase checks factor ownership and controls SMS rate limits.
        const challenge=await gotrue('/auth/v1/factors/'+body.factorId+'/challenge',token,authConfig,{
          method:'POST',body:{},fetchImpl
        });
        if(!UUID.test(String(challenge.id||'')))throw new AuthError('Challenge rejected',403);
        return json({challengeId:challenge.id});
      }
      if(!UUID.test(String(body.factorId||''))||!/^[0-9]{6}$/.test(String(body.code||'')))
        throw new AuthError('Invalid verification',422);
      const factors=await verifiedFactors(token,authConfig,{fetchImpl});
      if(temporary&&factors.length&&!factors.some(f=>f.id===body.factorId))
        throw new AuthError('Unrecognized factor',403);
      let challengeId=String(body.challengeId||'');
      if(!challengeId){
        // TOTP can challenge-and-verify in one request. SMS must first send a text.
        const factor=factors.find(f=>f.id===body.factorId);
        if(factor?.type==='phone')throw new AuthError('SMS challenge required',422);
        const challenge=await gotrue('/auth/v1/factors/'+body.factorId+'/challenge',token,authConfig,{method:'POST',body:{},fetchImpl});
        challengeId=String(challenge.id||'');
      }
      if(!UUID.test(challengeId))throw new AuthError('Challenge rejected',403);
      const session=await gotrue('/auth/v1/factors/'+body.factorId+'/verify',token,authConfig,{
        method:'POST',body:{challenge_id:challengeId,code:String(body.code)},fetchImpl
      });
      if(!session.access_token||!session.refresh_token||!Number.isFinite(session.expires_in))
        throw new AuthError('Invalid verified session',503);
      const verified=await verifiedIdentity(session.access_token,{...authConfig,fetchImpl});
      if(verified.id!==user.id)throw new AuthError('Session identity mismatch',403);
      aal2Required(session.access_token,verified);
      const verifiedRole=await memberRole({...verified,accessToken:session.access_token});
      const cookies=sessionCookies(session);
      return json({ok:true,role:verifiedRole,csrf:cookies.csrf},200,[...cookies.headers,clearPendingCookie()]);
    }catch(error){
      const status=error instanceof AuthError?error.status:500;
      // Never return enrollment secrets, codes, bearer tokens, or upstream error messages.
      return json({error:status===429?'Too many attempts. Try again later.':'MFA request rejected'},status);
    }
  };
}
