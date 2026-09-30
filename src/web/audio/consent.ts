import {u} from '../net';

let accepted=false;
/** Ask before opening the device or contacting a recognition provider. */
export function listeningConsent(signal:AbortSignal):Promise<boolean> {
  if(signal.aborted)return Promise.resolve(false);
  if(accepted)return Promise.resolve(true);
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');
    dialog.className='listening-consent';
    dialog.setAttribute('aria-labelledby','listening-consent-title');
    // The explanation scrolls on a small phone; the agreement and both buttons always stay in view.
    dialog.innerHTML='<form method="dialog"><div class="lc-body"><h2 id="listening-consent-title">Before you turn on the microphone</h2><p>Your audio is sent to Soniox for recognition. Recognised words may go to OpenRouter and TypeSafe to help find the right ayah. This can reveal religious information.</p><p>Nurra does not save your audio or transcripts. You can stop at any time and keep reading without a microphone.</p><p><a target="_blank" rel="noopener">Read the privacy policy</a></p></div><div class="lc-actions"><label><input type="checkbox" required> I agree to this processing of my voice and recognised words.</label><div class="lc-buttons"><button value="cancel" formnovalidate>Keep reading</button><button value="allow">Agree and continue</button></div></div></form>';
    dialog.querySelector('a')!.href=u('/privacy.html');
    const finish=()=>{const yes=dialog.returnValue==='allow'&&!signal.aborted;accepted ||= yes;signal.removeEventListener('abort',abort);dialog.remove();resolve(yes);};
    const abort=()=>dialog.close('cancel');
    dialog.addEventListener('close',finish,{once:true});
    signal.addEventListener('abort',abort,{once:true});
    document.body.append(dialog);dialog.showModal();
  });
}
