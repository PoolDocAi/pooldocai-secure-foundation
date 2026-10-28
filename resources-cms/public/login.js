// Private Resources Studio: password plus a verified Supabase MFA factor.
// SMS is an explicit second factor (not passwordless phone sign-in).
const login=document.querySelector('#login');
const errorNode=document.querySelector('#error');
let mfaCsrf='';

async function postMfa(path,payload){
  const response=await fetch(path,{
    method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF-Token':mfaCsrf},
    body:JSON.stringify(payload)
  });
  let data;
  try{data=await response.json()}catch{throw Error('Verification service unavailable')}
  if(!response.ok)throw Error(data.error||'Verification rejected');
  return data;
}
function element(tag,text){
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  return node;
}
function makeMfaForm(setup,factors=[]){
  login.hidden=true;
  const form=element('form');form.id='mfa-verify';
  const title=element('h2',setup?'Protect your Studio account':'Verify your identity');
  const hint=element('p',setup
    ?'Choose text verification or an authenticator app. Both require your password first.'
    :'Choose an enrolled second factor. For text messages, request a new code below.');
  const error=element('p');error.setAttribute('role','alert');
  const modeLabel=element('label',setup?'Verification method':'Second factor');
  const selector=element('select');selector.setAttribute('aria-label','Verification method');
  if(setup){
    for(const [type,label] of [['phone','Text message (SMS)'],['totp','Authenticator app']]){
      const option=element('option',label);option.value=type;selector.append(option);
    }
  }else{
    for(const factor of factors){
      const option=element('option',factor.type==='phone'?'Text message':'Authenticator app');
      option.value=factor.id;
      option.dataset.type=factor.type;
      option.textContent=factor.name||option.textContent;
      selector.append(option);
    }
  }
  modeLabel.append(selector);
  const phoneLabel=element('label','Mobile phone number (international format)');
  const phone=element('input');phone.type='tel';phone.autocomplete='tel';phone.placeholder='+1 555 555 1234';
  phone.pattern='\\+[1-9][0-9]{7,14}';phone.maxLength=16;
  phoneLabel.append(phone);
  const qr=element('img');qr.alt='Authenticator QR code';qr.style.maxWidth='240px';qr.hidden=true;
  const send=element('button','Send verification text');send.type='button';
  const codeLabel=element('label','Six-digit verification code');
  const code=element('input');code.type='text';code.inputMode='numeric';code.autocomplete='one-time-code';
  code.pattern='[0-9]{6}';code.maxLength=6;code.required=true;codeLabel.append(code);
  const verify=element('button','Verify and open Studio');verify.className='primary';verify.type='submit';
  let factorId='',challengeId='';
  function selectedType(){
    return setup?selector.value:(selector.selectedOptions[0]?.dataset.type||'totp');
  }
  function reflect(){
    const kind=selectedType();
    qr.hidden=true;qr.removeAttribute('src');
    phoneLabel.hidden=!(setup&&kind==='phone');
    send.hidden=kind!=='phone'&&!setup;
    send.textContent=kind==='phone'?'Send verification text':'Generate authenticator QR code';
    send.hidden=!setup&&kind==='totp';
    factorId=setup?'':selector.value;
    challengeId='';
    verify.disabled=kind==='phone'||setup;
    code.value='';
    error.textContent='';
  }
  selector.addEventListener('change',reflect);
  send.addEventListener('click',async()=>{
    send.disabled=true;error.textContent='';
    try{
      const kind=selectedType();
      if(setup&&!factorId){
        const payload=kind==='phone'
          ?{type:'phone',phone:phone.value.replace(/\s+/g,'')}
          :{type:'totp'};
        const enrolled=await postMfa('/api/mfa/enroll',payload);
        factorId=enrolled.factorId;
        if(kind==='totp'){
          if(!String(enrolled.qrCode||'').startsWith('data:image/svg+xml'))
            throw Error('Invalid authenticator setup response');
          qr.src=enrolled.qrCode;qr.hidden=false;
          verify.disabled=false;
          code.focus();
          return;
        }
      }
      if(kind==='phone'){
        if(!factorId)factorId=selector.value;
        const challenge=await postMfa('/api/mfa/challenge',{factorId});
        challengeId=challenge.challengeId;
        verify.disabled=false;
        error.textContent='A verification text has been requested. Enter its six-digit code.';
        code.focus();
      }
    }catch(err){error.textContent=err.message}
    finally{send.disabled=false}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();verify.disabled=true;error.textContent='';
    try{
      const payload={factorId,code:code.value.trim()};
      if(selectedType()==='phone'){
        if(!challengeId)throw Error('Request a new verification text first');
        payload.challengeId=challengeId;
      }
      await postMfa('/api/mfa/verify',payload);
      location.assign('/admin/');
    }catch(err){error.textContent=err.message;code.select();verify.disabled=false}
  });
  form.append(title,hint,error,modeLabel,phoneLabel,send,qr,codeLabel,verify);
  login.after(form);
  reflect();
  if(!setup&&selectedType()==='totp')code.focus();
}
login.addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.target.querySelector('button');
  button.disabled=true;errorNode.textContent='';
  try{
    const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});
    if(!String(response.headers.get('content-type')||'').toLowerCase().includes('json'))
      throw Error('Sign-in service unavailable');
    const result=await response.json();
    if(!response.ok)throw Error('Sign-in rejected. Check your credentials.');
    if(result.mfaRequired===true&&typeof result.csrf==='string'){
      mfaCsrf=result.csrf;
      makeMfaForm(Boolean(result.setup),Array.isArray(result.factors)?result.factors:[]);
      return;
    }
    if(typeof result.id!=='string'||typeof result.role!=='string')
      throw Error('Invalid authentication response');
    location.assign('/admin/');
  }catch(err){errorNode.textContent=err.message}
  finally{button.disabled=false}
});
