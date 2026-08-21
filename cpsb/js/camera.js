/* ============ 摄像头扫描 ============ */
let stream=null, scanning=true, scanState='auto', scanTimer=null, facingMode='environment', torchOn=false, lightTimer=null, _lastNoResult=0;

const TORCH_OFF_SVG='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"></path></svg>';
const TORCH_ON_SVG='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"></path><circle cx="12" cy="8" r="2.4" fill="currentColor" stroke="none"></circle><path d="M11 5l-.6-1.4M13 5l.6-1.4M12 3.4V2"></path></svg>';

async function startCam(){
  await openCam(facingMode);
}
function torchSupported(){
  try{ const t=stream&&stream.getVideoTracks()[0]; return !!(t&&t.getCapabilities&&t.getCapabilities().torch); }catch(e){ return false; }
}
async function toggleTorch(){
  const btn=document.getElementById('torchBtn');
  try{
    const t=stream&&stream.getVideoTracks()[0];
    if(!t){ alert('请先开启摄像头'); return; }
    if(!torchSupported()){ alert('当前设备不支持灯光（手电筒）'); return; }
    torchOn=!torchOn;
    await t.applyConstraints({ advanced:[{ torch:torchOn }] });
    btn.classList.toggle('on', torchOn);
    btn.innerHTML = torchOn ? TORCH_ON_SVG : TORCH_OFF_SVG;
    if(torchOn){ btn.classList.remove('hidden','hint'); setCamStatus(); }
    else { /* 关灯后由亮度检测决定是否重新提示 */ }
  }catch(e){ alert('无法切换灯光：'+(e.message||e)); }
}
function avgBrightness(){
  const v=document.getElementById('video');
  if(!v||!v.videoWidth) return null;
  try{
    const c=document.createElement('canvas'); c.width=64; c.height=48;
    const ctx=c.getContext('2d'); ctx.drawImage(v,0,0,c.width,c.height);
    const d=ctx.getImageData(0,0,c.width,c.height).data;
    let sum=0; for(let i=0;i<d.length;i+=4){ sum+=(d[i]+d[i+1]+d[i+2])/3; }
    return sum/(d.length/4);
  }catch(e){ return null; }
}
function startLightCheck(){
  if(lightTimer) return;
  lightTimer=setInterval(()=>{
    if(!scanning||!stream) return;
    const b=avgBrightness();
    const btn=document.getElementById('torchBtn');
    if(b==null) return;
    if(b<45 && !torchOn){
      btn.classList.remove('hidden');
      btn.classList.add('hint');
      document.getElementById('camStatus').textContent='光线不足，点击 💡 开启灯光';
    } else if(!torchOn){
      btn.classList.add('hidden');
      btn.classList.remove('hint');
      setCamStatus();
    }
  }, 1500);
}
async function openCam(facing){
  try{
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    const cams = await navigator.mediaDevices.enumerateDevices().catch(()=>[]);
    const hasEnv = cams.some(d=>/environment|back|rear/i.test(d.label||''));
    const hasUser = cams.some(d=>/user|front/i.test(d.label||''));
    let constraint;
    const videoConstraint = { width:{ ideal:1920 }, height:{ ideal:1080 } };
    if(hasEnv && hasUser){ constraint = { video:{ facingMode:{ exact:facing}, ...videoConstraint }, audio:false }; }
    else { constraint = { video:videoConstraint, audio:false }; }
    stream = await navigator.mediaDevices.getUserMedia(constraint);
    facingMode = facing;
    torchOn=false; const tb=document.getElementById('torchBtn'); if(tb){ tb.classList.add('hidden'); tb.classList.remove('on','hint'); tb.innerHTML=TORCH_OFF_SVG; }
    document.getElementById('video').srcObject = stream;
    if(scanning) startAutoScan();
    setCamStatus(); updateScanBtn();
    startLightCheck();
  }catch(e){
    try{ stream = await navigator.mediaDevices.getUserMedia({ video:{ width:{ ideal:1920 }, height:{ ideal:1080 } }, audio:false }); document.getElementById('video').srcObject=stream; if(scanning) startAutoScan(); setCamStatus(); updateScanBtn(); startLightCheck(); }
    catch(e2){ document.getElementById('camStatus').textContent='无法访问摄像头'; }
  }
}
function setCamStatus(){
  const el=document.getElementById('camStatus');
  if(el) el.textContent = scanning ? '扫描中… 对准车牌保持 1~2 秒' : '已暂停';
}
function stopCam(){ if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } if(scanTimer){ clearInterval(scanTimer); scanTimer=null; } if(lightTimer){ clearInterval(lightTimer); lightTimer=null; } scanning=true; scanState='auto'; updateScanBtn(); }
// auto | paused | manual
function updateScanBtn(){
  const btn=document.getElementById('stopBtn');
  const mask=document.getElementById('camMask');
  // 毛玻璃遮罩：仅出结果待继续(manual)时显示，盖住整个扫描区域
  if(mask) mask.classList.toggle('hidden', scanState!=='manual');
  // 外层停止/拍照按钮：manual 时隐藏，避免与框内遮罩按钮重复
  if(btn) btn.classList.toggle('hidden', scanState==='manual');
  if(scanState==='auto'){ btn.textContent='停止扫描'; }
  else if(scanState==='paused'){ btn.textContent='拍照识别'; }
  else if(scanState==='manual'){ btn.textContent='继续扫描'; }
}
function startScanning(){
  // 真正恢复自动扫描（不含互递归调用）
  scanState='auto'; scanning=true;
  closeResult();
  document.getElementById('camStatus').textContent='扫描中… 对准车牌保持 1~2 秒';
  updateScanBtn();
  if(stream&&!scanTimer) startAutoScan();
}
function resumeScan(){
  // 框内“继续扫描”按钮：恢复自动扫描，并清除上一次结果
  if(scanState!=='manual') return;
  startScanning();
}
function toggleScan(){
  if(scanState==='auto'){
    scanState='paused'; scanning=false;
    if(scanTimer){ clearInterval(scanTimer); scanTimer=null; }
    document.getElementById('camStatus').textContent='已暂停，可点击下方按钮拍照识别';
    updateScanBtn();
  }else if(scanState==='paused'){
    doScanOnce(true);
  }else if(scanState==='manual'){
    resumeScan();
  }
}
function onScanSuccess(){
  // 识别成功后：停止自动扫描，显示毛玻璃遮罩，必须点击“继续扫描”才恢复
  scanning=false;
  if(scanTimer){ clearInterval(scanTimer); scanTimer=null; }
  scanState='manual';
  updateScanBtn();
}
async function doScanOnce(manual){
  if(!stream) return;
  const v=document.getElementById('video');
  const vw=v.videoWidth, vh=v.videoHeight;
  if(!vw||!vh) return;
  // 发送完整高清帧，不再裁剪（裁剪会把车牌压得太小导致 OCR 失败）
  let w=vw, h=vh;
  const max=1280;
  if(w>max || h>max){
    if(w>h){ h=Math.round(h*max/w); w=max; }
    else { w=Math.round(w*max/h); h=max; }
  }
  const c=document.createElement('canvas'); c.width=w; c.height=h;
  c.getContext('2d').drawImage(v,0,0,w,h);
  const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',0.92));
  const fd=new FormData(); fd.append('image',blob,'f.jpg'); fd.append('channel','web');
  try{
    const r=await fetch(API+'/api/recognize',{method:'POST',body:fd});
    const j=await r.json();
    const plateNo=(j.data&&j.data.plateNo)?j.data.plateNo:j.plateNo;
    if(j.success&&plateNo){ showResult(plateNo,j.data); onScanSuccess(); return true; }
    else {
      document.getElementById('camStatus').textContent='未识别到车牌，请对准车牌、保持光线充足';
      // 仅在自动扫描进行中才播报（手动查询/暂停/出结果待继续时不播）
      if(scanState==='auto' && scanning){
        const ns=Date.now();
        if(ns-_lastNoResult>4000){ _lastNoResult=ns; playSound('noresult'); }   // 4 秒内不重复播报
      }
    }
  }catch(e){ document.getElementById('camStatus').textContent='网络异常，识别请求失败，请重试'; }
  return false;
}
function startAutoScan(){
  if(scanTimer) return;
  scanTimer = setInterval(async ()=>{
    if(!stream||!scanning) return;
    await doScanOnce(false);
  }, 2000);
}
async function switchCam(){
  const next = (facingMode==='environment') ? 'user' : 'environment';
  document.getElementById('camStatus').textContent='切换镜头中…';
  await openCam(next);
}

/* 出结果后点击 X / 恢复扫描时清空结果；manual 时自动恢复扫描 */
function closeResult(){
  document.getElementById('result').innerHTML='';
  if(scanState==='manual') startScanning();
}

window.addEventListener('DOMContentLoaded',startCam);
window.addEventListener('beforeunload',stopCam);
