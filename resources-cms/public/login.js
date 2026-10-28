// Studio sign-in: password establishes a short-lived MFA-only session, never CMS access.
// QR secrets and one-time codes stay in the user's browser and Supabase Auth.
const login=document.querySelector('#login');
const errorNode=document.querySelector('#error');
let mfaCsrf='', factorId='';
async function postMfa(path,payload){
  const response=await fetch(path,{
    method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF-Token':mfaCsrf},
    body:JSON.stringify(payload)
  });
  let body;
  try{body=await response.json()}catch{throw Error('Authentication service unavailable')}
  if(!response.ok)throw Error(body.error||'Verification rejected. Try again.');
  return body;
}
function addMfaForm(setup,factors=[]){
  login.hidden=true;
  const form=document.createElement('form');
  form.id='mfa-verify';
  const title=document.createElement('h2');
  title.textContent=setup?'Set up two-step verification':'Authenticator verification';
  const instructions=document.createElement('p');
  instructions.textContent=setup
    ?'Scan the QR code with your authenticator app, then enter its six-digit code. Keep a backup authenticator on a different device.'
    :'Enter the six-digit code from your authenticator app.';
  form.append(title,instructions);
  const qr=document.createElement('img');
  qr.alt='Authenticator setup QR code';
  qr.style.maxWidth='240px';
  qr.hidden=true;
  form.append(qr);
  if(!setup&&factors.length>1){
    const factorSelect=document.createElement('select');
    factorSelect.setAttribute('aria-label','Authenticator');
    for(const factor of factors){const option=document.createElement('option');option.value=factor.id;option.textContent=factor.name;factorSelect.append(option)}
    factorId=factors[0].id;
    factorSelect.addEventListener('change',()=>{factorId=factorSelect.value});
    form.append(factorSelect);
  }else if(!setup&&factors.length){
    factorId=factors[0].id;
  }
  const label=document.createElement('label');
  label.textContent='Authenticator code';
  const input=document.createElement('input');
  input.type='text';input.inputMode='numeric';input.autocomplete='one-time-code';
  input.pattern='[0-9]{6}';input.maxLength=6;input.required=true;
  label.append(input);
  const submit=document.createElement('button');
  submit.type='submit';submit.className='primary';submit.textContent='Verify and open Studio';
  form.append(label,submit);
  login.after(form);
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    submit.disabled=true;errorNode.textContent='';
    try{
      await postMfa('/api/mfa/verify',{factorId,code:input.value.trim()});
      location.assign('/admin/');
    }catch(err){errorNode.textContent=err.message;input.select()}
    finally{submit.disabled=false}
  });
  if(setup){
    submit.disabled=true;
    postMfa('/api/mfa/enroll',{}).then(data=>{
      factorId=data.factorId;
      if(!/^data:image\/svg\+xml[;,]/i.test(data.qrCode||''))throw Error('Invalid enrollment QR code');
      qr.src=data.qrCode;qr.hidden=false;submit.disabled=false;input.focus();
    }).catch(err=>{errorNode.textContent=err.message+' Return to sign in and try again.'});
  }else input.focus();
}
login.addEventListener('submit',async e=>{
  e.preventDefault();
  const button=e.target.querySelector('button');
  button.disabled=true;errorNode.textContent='';
  try{
    const response=await fetch('/api/login',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(Object.fromEntries(new FormData(e.target)))
    });
    const type=response.headers.get('content-type')||'';
    if(!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(type))
      throw Error('Sign-in service unavailable. Try again.');
    const result=await response.json();
    if(!response.ok)throw Error('Sign-in rejected. Check credentials or try again.');
    if(result.mfaRequired===true && typeof result.csrf==='string'){
      mfaCsrf=result.csrf;
      addMfaForm(Boolean(result.setup),Array.isArray(result.factors)?result.factors:[]);
      return;
    }
    if(!result||typeof result.id!=='string'||typeof result.role!=='string')
      throw Error('Invalid authentication response.');
    location.assign('/admin/');
  }catch(err){errorNode.textContent=err.message}
  finally{button.disabled=false}
});
