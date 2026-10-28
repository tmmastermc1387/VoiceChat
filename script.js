const BROKER = "wss://broker.emqx.io:8084/mqtt";
const PREFIX = "hoosha-voice-v1/";
let mqttClient = null, peer = null;
let myId = null, myName = "", myRoom = "", myPeerId = "";
let users = new Map();
let localMicStream = null, localScreenStream = null;
let micOn = true, sharing = false;
let voiceCalls = new Map(), screenCalls = new Map();
const $ = (id) => document.getElementById(id);
function makeCode(){
  const c="ABCDEFGHJKMNPQRSTUVWXYZ23456789";let s="";
  for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)];
  return s;
}
function getRoomFromUrl(){
  const u=new URLSearchParams(location.search);
  return (u.get("room")||"").toUpperCase().trim();
}
window.addEventListener("DOMContentLoaded",()=>{
  const r=getRoomFromUrl();
  if(r) $("roomInput").value=r;
  const n=localStorage.getItem("patoogh-voice-name");
  if(n) $("nameInput").value=n;
});
$("randomBtn").onclick=()=>{ $("roomInput").value=makeCode(); };
function setStatus(on,t){
  $("statusDot").className="dot "+(on?"on":"off");
  $("statusText").textContent=t;
}
$("joinBtn").onclick=async()=>{
  myName=$("nameInput").value.trim().slice(0,20)||"مهمان";
  myRoom=$("roomInput").value.trim().toUpperCase()||makeCode();
  localStorage.setItem("patoogh-voice-name",myName);
  myId="u-"+Math.random().toString(36).slice(2,9);
  $("joinBtn").textContent="دارم میکروفون رو روشن می‌کنم...";
  try{
    localMicStream=await navigator.mediaDevices.getUserMedia({audio:true});
  }catch(e){
    alert("دسترسی میکروفون داده نشد. با کروم و لینک https باز کن و Allow بزن.");
    $("joinBtn").textContent="ورود با میکروفون";
    return;
  }
  $("joinScreen").classList.add("hidden");
  $("roomScreen").classList.remove("hidden");
  $("roomCode").textContent=myRoom;
  myPeerId=("pgh-"+myRoom.toLowerCase()+"-"+myId).replace(/[^a-z0-9-]/g,"");
  initPeer();
  initMqtt();
};
function topics(){
  const b=PREFIX+myRoom;
  return {presence:b+"/presence",control:b+"/control"};
}
function initPeer(){
  setStatus(false,"در حال وصل‌شدن...");
  try{ peer=new Peer(myPeerId); }catch(e){ setStatus(false,"خطا در ساخت Peer"); return; }
  peer.on("open",()=>{
    setStatus(true,"وصل شدی");
    sendPresence("join");
    callAllVoices();
  });
  peer.on("call",(call)=>{
    const type=call.metadata&&call.metadata.type;
    if(type==="screen"){
      try{ call.answer(); }catch(e){}
      handleCall(call);
    }else{
      try{ call.answer(localMicStream); }catch(e){}
      handleCall(call);
      if(sharing&&localScreenStream){
        setTimeout(()=>{
          try{
            const sc=peer.call(call.peer,localScreenStream,{metadata:{type:"screen",name:myName}});
            handleCall(sc);
          }catch(e){}
        },800);
      }
    }
  });
  peer.on("error",(e)=>{
    if(e.type==="peer-unavailable") return;
    if(e.type==="unavailable-id-taken"){
      myPeerId=myPeerId+"-"+Math.floor(Math.random()*99);
      try{ peer=new Peer(myPeerId); }catch(err){}
    }
  });
}
function initMqtt(){
  mqttClient=mqtt.connect(BROKER,{clientId:myId+"-"+Date.now(),clean:true,reconnectPeriod:3000,connectTimeout:10000});
  const T=topics();
  mqttClient.on("connect",()=>{
    mqttClient.subscribe([T.presence,T.control]);
    sendPresence("join");
    setInterval(()=>sendPresence("heartbeat"),10000);
    setInterval(cleanup,5000);
  });
  mqttClient.on("message",(topic,buf)=>{
    try{
      const d=JSON.parse(buf.toString());
      if(topic.endsWith("/presence")) onPresence(d);
      else if(topic.endsWith("/control")) onControl(d);
    }catch(e){}
  });
  mqttClient.on("reconnect",()=>setStatus(false,"قطع شد، تلاش دوباره..."));
}
function sendPresence(type){
  if(!mqttClient||!mqttClient.connected) return;
  mqttClient.publish(topics().presence,JSON.stringify({type,id:myId,name:myName,peerId:myPeerId,time:Date.now()}),{qos:0});
}
function sendControl(obj){
  if(!mqttClient||!mqttClient.connected) return;
  mqttClient.publish(topics().control,JSON.stringify(obj),{qos:0});
}
function onPresence(d){
  if(!d||!d.id||!d.peerId) return;
  if(d.type==="leave"){
    const old=users.get(d.id);
    users.delete(d.id);
    renderUsers();
    if(old) removePeerMedia(old.peerId);
    return;
  }
  const isNew=!users.has(d.id);
  users.set(d.id,{name:d.name,peerId:d.peerId,last:Date.now()});
  renderUsers();
  if(isNew&&d.id!==myId&&peer&&peer.open){
    sendPresence("heartbeat");
    setTimeout(()=>{ callVoice(d.peerId); if(sharing) callScreenTo(d.peerId); },600);
  }
}
function onControl(d){
  if(!d) return;
  if(d.action==="screen-stop"&&d.peerId){ removeScreenTile(d.peerId); }
}
function cleanup(){
  const now=Date.now();let ch=false;
  for(let [id,u] of users){ if(now-u.last>25000){ users.delete(id); removePeerMedia(u.peerId); ch=true; } }
  if(ch) renderUsers();
}
function renderUsers(){
  const ul=$("usersList");ul.innerHTML="";
  if(!users.has(myId)) users.set(myId,{name:myName+" (تو)",peerId:myPeerId,last:Date.now()});
  for(let u of users.values()){
    const li=document.createElement("li");li.textContent=u.name;ul.appendChild(li);
  }
  $("onlineCount").textContent=users.size;
}
function callAllVoices(){
  for(let u of users.values()){
    if(u.peerId&&u.peerId!==myPeerId) callVoice(u.peerId);
  }
}
function callVoice(peerId){
  if(!peer||!peer.open||!localMicStream||!peerId||peerId===myPeerId) return;
  if(voiceCalls.has(peerId)) return;
  try{
    const call=peer.call(peerId,localMicStream,{metadata:{type:"voice",name:myName}});
    handleCall(call);
  }catch(e){}
}
function callScreenTo(peerId){
  if(!peer||!peer.open||!localScreenStream||!peerId||peerId===myPeerId) return;
  try{
    const call=peer.call(peerId,localScreenStream,{metadata:{type:"screen",name:myName}});
    handleCall(call);
  }catch(e){}
}
function handleCall(call){
  if(!call) return;
  const remotePeer=call.peer;
  const type=call.metadata&&call.metadata.type;
  const rname=(call.metadata&&call.metadata.name)||"دوست";
  if(type==="voice") voiceCalls.set(remotePeer,call);
  else if(type==="screen") screenCalls.set(remotePeer+"-s",call);
  call.on("stream",(stream)=>{
    if(type==="screen") showScreen(remotePeer,rname,stream);
    else showVoice(remotePeer,rname,stream);
  });
  call.on("close",()=>{
    if(type==="screen"){ removeScreenTile(remotePeer); screenCalls.delete(remotePeer+"-s"); }
    else{ voiceCalls.delete(remotePeer); removeVoice(remotePeer); }
  });
  call.on("error",()=>{});
}
function showVoice(peerId,name,stream){
  let a=document.getElementById("a-"+peerId);
  if(!a){
    a=document.createElement("audio");
    a.id="a-"+peerId;a.autoplay=true;a.playsInline=true;
    $("audios").appendChild(a);
  }
  a.srcObject=stream;
  a.play().catch(()=>{});
}
function removeVoice(peerId){
  const a=document.getElementById("a-"+peerId);
  if(a) a.remove();
}
function showScreen(peerId,name,stream){
  $("noScreen")&&$("noScreen").remove();
  let tile=document.getElementById("s-"+peerId);
  if(!tile){
    tile=document.createElement("div");tile.className="tile";tile.id="s-"+peerId;
    const v=document.createElement("video");v.autoplay=true;v.playsInline=true;v.controls=false;
    v.id="v-"+peerId;
    const cap=document.createElement("div");cap.className="cap";
    cap.innerHTML="<span></span><span>🔴 زنده</span>";
    cap.firstChild.textContent=name;
    tile.appendChild(v);tile.appendChild(cap);
    $("screensGrid").appendChild(tile);
  }
  const v=tile.querySelector("video");
  v.srcObject=stream;
  v.play().catch(()=>{});
  stream.getVideoTracks().forEach(tr=>{ tr.onended=()=>removeScreenTile(peerId); });
}
function removeScreenTile(peerId){
  const t=document.getElementById("s-"+peerId);
  if(t) t.remove();
  if($("screensGrid").children.length===0){
    const d=document.createElement("div");d.id="noScreen";d.className="empty";
    d.textContent="هنوز کسی اسکرین شیر نکرده. دکمه «شیر اسکرین» رو بزن تا همه ببینن.";
    $("screensGrid").appendChild(d);
  }
}
function removePeerMedia(peerId){
  removeVoice(peerId);removeScreenTile(peerId);
  const vc=voiceCalls.get(peerId);if(vc){try{vc.close();}catch(e){} voiceCalls.delete(peerId);}
}
$("micBtn").onclick=()=>{
  if(!localMicStream) return;
  micOn=!micOn;
  localMicStream.getAudioTracks().forEach(t=>t.enabled=micOn);
  $("micBtn").textContent=micOn?"🎙️ میکروفون روشن":"🔇 میکروفون بسته";
  $("micBtn").className="ctrl "+(micOn?"on":"");
};
$("screenBtn").onclick=async()=>{
  if(!sharing) await startScreen();
  else stopScreen();
};
async function startScreen(){
  try{
    localScreenStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
  }catch(e){ alert("شیر اسکرین کنسل شد."); return; }
  sharing=true;
  $("screenBtn").textContent="⏹️ قطع شیر اسکرین";
  $("screenBtn").className="ctrl sharing";
  showScreen(myPeerId,myName+" (تو)",localScreenStream);
  for(let u of users.values()){ if(u.peerId!==myPeerId) callScreenTo(u.peerId); }
  localScreenStream.getVideoTracks().forEach(tr=>{ tr.onended=()=>stopScreen(); });
}
function stopScreen(){
  sharing=false;
  $("screenBtn").textContent="🖥️ شیر اسکرین";
  $("screenBtn").className="ctrl";
  if(localScreenStream){ try{localScreenStream.getTracks().forEach(t=>t.stop());}catch(e){} localScreenStream=null; }
  removeScreenTile(myPeerId);
  sendControl({action:"screen-stop",peerId:myPeerId,id:myId});
  for(let [k,c] of screenCalls){ try{c.close();}catch(e){} }
  screenCalls.clear();
}
$("copyLinkBtn").onclick=async()=>{
  const link=location.origin+location.pathname+"?room="+myRoom;
  try{ await navigator.clipboard.writeText(link); $("copyLinkBtn").textContent="کپی شد!"; }
  catch(e){ prompt("این لینک رو کپی کن و بده به رفقات:",link); return; }
  setTimeout(()=>$("copyLinkBtn").textContent="کپی لینک دعوت",2000);
};
$("leaveBtn").onclick=()=>{
  try{ sendPresence("leave"); sendControl({action:"screen-stop",peerId:myPeerId,id:myId}); }catch(e){}
  try{ mqttClient&&mqttClient.end(); }catch(e){}
  try{ peer&&peer.destroy(); }catch(e){}
  location.reload();
};
window.addEventListener("beforeunload",()=>{ try{sendPresence("leave");}catch(e){} });