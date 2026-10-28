// Owner-only backup authenticator enrollment, served inside authenticated Studio.
// Do not log, cache, transmit or store QR secrets and one-time codes outside Supabase Auth.
(() => {
  'use strict';
  const container=document.querySelector('.sidebar-bottom');
  if(!container)return;
  const button=document.createElement('button');
  button.type='button';
  button.textContent='Add backup authenticator';
  container.prepend(button);
  const modal=document.createElement('dialog');
  modal.setAttribute('aria-label','Set up backup two-step verification');
  const form=document.createElement('form');
  form.method='dialog';
  const title=document.createElement('h2');title.textContent='Backup authenticator';
  const explain=document.createElement('p');explain.textContent='Use a second device or authenticator app, separate from your primary. Verify it before relying on it for account recovery.';
  const qr=document.createElement('img');
  qr.alt='Backup authenticator QR code';qr.width=220;qr.hidden=true;
  const label=document.createElement('label');label.textContent='Six-digit code';
  const codeInput=document.createElement('input');codeInput.inputMode='numeric';codeInput.pattern='[0-9]{6}';codeInput.maxLength=6;codeInput.required=true;codeInput.autocomplete='one-time-code';
  label.append(codeInput);
  const status=document.createElement('p');status.setAttribute('role','alert');
  const verify=document.createElement('button');verify.type='submit';verify.className='primary';verify.textContent='Verify backup';verify.disabled=true;
  const close=document.createElement('button');close.type='button';close.textContent='Cancel';close.addEventListener('click',()=>modal.close());
  form.append(title,explain,qr,label,status,verify,close);
  modal.append(form);document.body.append(modal);
  let factorId='';
  const csrf=()=>decodeURIComponent(document.cookie.split('; ').find(x=>x.startsWith('__Host-pooldocai-cms-csrf='))?.split('=').slice(1).join('=')||'');
  async function send(path,payload){
    const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf()},body:JSON.stringify(payload)});
    const body=await r.json();
    if(!r.ok)throw Error(body.error||'Verification unavailable');
    return body;
  }
  button.addEventListener('click',async()=>{
    status.textContent='Preparing secure enrollment…';qr.hidden=true;verify.disabled=true;codeInput.value='';factorId='';
    modal.showModal();
    try {
      const result=await send('/api/mfa/enroll',{type:'totp'});
      if(!/^data:image\/svg\+xml[;,]/.test(result.qrCode||''))throw Error('Invalid QR response');
      factorId=result.factorId;qr.src=result.qrCode;qr.hidden=false;verify.disabled=false;
      status.textContent='Scan the QR code, then enter the code from your backup app.';
    }catch(err){status.textContent=err.message}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();status.textContent='Verifying…';verify.disabled=true;
    try {await send('/api/mfa/verify',{factorId,code:codeInput.value.trim()});status.textContent='Backup authenticator verified.';qr.hidden=true;setTimeout(()=>location.reload(),750)}
    catch(err){status.textContent=err.message;verify.disabled=false}
  });
  modal.addEventListener('close',()=>{qr.removeAttribute('src');factorId='';codeInput.value=''});
})();
