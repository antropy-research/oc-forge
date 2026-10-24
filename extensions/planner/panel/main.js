(()=>{var p="openchamber.sdk",u=1;var Ve=`
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [data-oc-scrolling] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [data-oc-scrolling] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [data-oc-scrolling] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function Xt(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(f)=>{let E=f.target===e?r:f.target;if(!(E instanceof Element))return;if(!E.hasAttribute("data-oc-scrolling"))E.setAttribute("data-oc-scrolling","");let g=s.get(E);if(g!==void 0)clearTimeout(g);s.set(E,setTimeout(()=>{s.delete(E),E.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Mo=`(${Xt.toString()})(document);`;var je=128,ze=65536;var me=128;var he=65536;var zt=/^[a-z][a-z0-9-]{0,39}$/;var Bt=(e)=>Object(e)===e&&!Array.isArray(e),Ke=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Vt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,jt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Kt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Bt(s)||!zt.test(s.id)||!Vt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!Ke(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!Ke(s,["kind","id","label","value","options","disabled"]))return!1;if(!jt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let f=new Set;for(let E of s.options){if(!Bt(E)||!Ke(E,["value","label"])||!jt(E.value)||!Vt(E.label)||f.has(E.value))return!1;f.add(E.value)}if(!f.has(s.value))return!1}return!0};var xe=20000000,be=256;var We=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Wt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var Jt=/^[A-Za-z0-9_-]{1,80}$/;var Yt=["left","right","top","bottom"];var Qt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let f=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let E of f)if(!Qt(E,r+1,s))return!1;return!0},Je=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(Je);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(Je)}return String(e)===e||Number.isFinite(e)},Ye=(e)=>{try{if(String(e.id)!==e.id||!Jt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!Yt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!Qt(e.data)||!Je(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var qt=["file","directory","other","missing"],Ze=(e)=>Boolean(e&&"sessionId"in e),qe=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var eo=/^[0-9a-f]{7,64}$/i,et=(e)=>eo.test(e),Ae=500,ke=32000,to=16000,oo=128,ro=200,no=2000,so=16000,io=80,ao=200,co=16000;var lo=2000;var tt=20000,ge=1024,ye=2000000;var Oe=64000,ve=8000,ot=4000;var rt=90000;var po=999,uo=1e4,ce=500,Eo=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],fo=["stopped","starting","ready","failed"],Lo=new Set(Eo),_o=(e)=>Lo.has(e),So=(e)=>e&&_o(e)?e:"HOST_REJECTED",J=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(J);if(Object(e)===e)return Object.values(e).every(J);return!1},To=(e)=>J(e)&&JSON.stringify(e).length<=co,Zt=(e)=>e?.trim().slice(0,ao)??"",Y=(e)=>{let r=e.id.trim().slice(0,oo),s=e.title.trim().slice(0,ro),f=e.url.trim().slice(0,no),E=e.text?.trim().slice(0,so),g=e.author?.trim().slice(0,io),G=e.kind==="pull"?"pull":"issue",y={providerId:e.providerId.trim(),id:r,title:s||r,url:f,kind:G};if(E)y.text=E;if(g)y.author=g;if(G==="pull"){let U=Zt(e.branches?.head),B=Zt(e.branches?.base);if(U&&B)y.branches={head:U,base:B}}if(To(e.data))y.data=e.data;return y},nt=(e)=>{let r=Y(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},st=(e)=>{let r={text:e.text.trim().slice(0,to)};if(e.send)r.send=!0;return r},it=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(po,Math.max(0,Math.round(e)))},at=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(uo,Math.max(0,Math.ceil(e)))};var Q=(e)=>e.length>0&&e.length<=ge&&!e.includes("\x00")&&!e.includes("\\");var Re=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>lo)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Go=new Set(fo),ct=(e)=>Boolean(e&&"status"in e&&Go.has(String(e.status))&&!("body"in e)),we=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),dt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),lt=(e)=>Boolean(e&&"written"in e&&e.written===!0),pt=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),No=new Set(qt),ut=(e)=>Boolean(e&&"kind"in e&&"size"in e&&No.has(String(e.kind))&&Number.isFinite(e.size)),Et=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Po=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved"]),Do=(e)=>Object(e)===e?e:null,Qe=(e)=>String(e)===e&&e.length>0,$o=(e)=>{if(!Qe(e.id))return null;if(e.ok===!0){let r={channel:p,v:u,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Qe(e.error))return{channel:p,v:u,type:"result",id:e.id,ok:!1,error:e.error,code:So(Qe(e.code)?e.code:void 0)};return null},ft=(e)=>{let r=Do(e);if(!r||r.channel!==p||r.v!==u)return null;if(r.type==="result")return $o(r);if(!Po.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var mo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Fo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class a extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var ho=()=>Promise.reject(new a("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Ue=()=>Promise.reject(new a("BAD_PATH",`File path must be 1 to ${ge} characters without NUL or backslash.`)),Ie=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new a("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},l=(e)=>(e.value+=1,`oc-${e.value}`),_t=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new a("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),f=e.requestTimeoutMs??tt,E=new Set,g=new Set,G=new Set,y=new Set,U=new Set,B=new Set,te=new Set,pe=new Set,ue=new Set,oe=null,re=null,Ee=new Set,fe=new Set,ne=null,se=null,Fe=!1,z=new Map,K=new Map,W=new Map,P=!1,d={value:0},c=null,D=null,ie=!1,ae=!1,It=null,Ct=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},M=(t)=>{r.parent.postMessage(t,"*")},k=(t,o)=>{for(let n of t)try{n(o)}catch(i){console.error(i)}},Mt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=ft(t.data);if(!o)return;if(o.type==="workspace"){let i=K.get(o.payload.subscriptionId);if(i)k([i],o.payload.snapshot);return}if(o.type==="shells"){let i=W.get(o.payload.subscriptionId);if(i)k([i],o.payload.snapshot);return}if(o.type==="ready"){if(c=o.payload,D=Ct(o.payload.session),k(E,o.payload),k(g,o.payload.directory),k(G,o.payload.session),D)k(y,D);k(U,o.payload.connection),k(B,o.payload.settings),k(te,o.payload.item);return}if(o.type==="directory"){if(c)c={...c,directory:o.payload.directory};k(g,o.payload.directory);return}if(o.type==="session"){if(c)c={...c,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Ct(o.payload.session);k(G,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,k(y,o.payload);return}if(o.type==="connection"){if(c)c={...c,connection:o.payload.connection};k(U,o.payload.connection);return}if(o.type==="settings"){if(c)c={...c,settings:o.payload.settings};k(B,o.payload.settings);return}if(o.type==="item"){if(c)c={...c,item:o.payload.item};k(te,o.payload.item);return}if(o.type==="status-control-event"){k(pe,o.payload);return}if(o.type==="popover-closed"){k(ue,o.payload);return}if(o.type==="action"){let i=(_)=>{if(!P)M({channel:p,v:u,type:"action-result",id:o.id,payload:_})},S=re;if(!S){i({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>S(o.payload)).then(()=>i({ok:!0}),(_)=>{let A=(_ instanceof Error?_.message:String(_)).trim();i({ok:!1,error:(A||"Action failed.").slice(0,ce)})});return}if(o.type==="file-open"){let i=o.payload;if(se&&Wt(se,i))return;se=i,k(Ee,o.payload);return}if(o.type==="file-saved"){k(fe,o.payload.version);return}if(o.type==="file-snapshot"){let i=(A)=>{if(!P)M({channel:p,v:u,type:"file-snapshot-result",id:o.id,payload:A})},S=(A)=>i({error:(A.trim()||"Could not read the edited file.").slice(0,ce)}),_=ne;if(!_){S("This extension does not edit files.");return}Promise.resolve().then(()=>_(o.payload.purpose)).then((A)=>{if(We(A)>xe){S(`The file is over ${xe} ${"bytes"in A?"bytes":"characters"}.`);return}if(A.version.length>be){S(`The snapshot version is over ${be} characters.`);return}i({snapshot:"bytes"in A?{bytes:A.bytes,version:A.version}:{content:A.content,version:A.version}})},(A)=>S(A instanceof Error?A.message:String(A)));return}if(o.type==="resolve"){let i=(_)=>{M({channel:p,v:u,type:"resolve-result",id:o.id,payload:_})},S=oe;if(!S){i({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>S(o.payload)).then((_)=>i({item:_?Y(_):null}),(_)=>{let A=(_ instanceof Error?_.message:String(_)).trim();i({error:(A||"Command failed.").slice(0,ce)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new a(o.code,o.error))};r.addEventListener("message",Mt),M({channel:p,v:u,type:"hello"});let v=(t,o=f)=>{if(P||r.parent===r)return Promise.reject(new a("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,i)=>{let S=setTimeout(()=>{z.delete(t.id),i(new a("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:i,timer:S}),M(t)})},x=(t)=>v(t).then(()=>{return}),b={channel:p,v:u},He=(t)=>{if(!P&&r.parent!==r)M(t)},Lt=()=>He({...b,type:"file-save"}),Gt=(t)=>{if(!mo(t)||!Fo(t))return;t.preventDefault(),Lt()},Nt=(t)=>{if(!mo(t)||t.key!=="Escape"||c?.surface!=="popover"||!c.popover)return;t.preventDefault(),Ft(c.popover.id,"escape").catch(()=>{return})},_e=()=>{let t=c?.surface==="popover"?c.popover:void 0;if(!t)return;let o=ie||ae;if(It===o)return;It=o,Ht(t.id,o).catch(()=>{return})},Se=()=>{if(c?.surface!=="popover"||ie)return;ie=!0,_e()},Pt=(t)=>{if(c?.surface!=="popover"||t.relatedTarget!==null||!ie)return;ie=!1,_e()},Dt=()=>{if(c?.surface!=="popover"||ae)return;ae=!0,_e()},$t=()=>{if(c?.surface!=="popover"||!ae)return;ae=!1,_e()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new a("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Xe=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await v({...b,type:"workspace-read",id:l(d),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new a("HOST_REJECTED","Host did not return workspace data.");return o},Be=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=l(d);K.set(n,o);try{await x({...b,type:"workspace-subscribe",id:l(d),payload:{subscriptionId:n,query:t}})}catch(i){if(K.delete(n),!P)M({...b,type:"workspace-unsubscribe",id:l(d),payload:{subscriptionId:n}});throw i}return()=>{if(!K.delete(n)||P)return;M({...b,type:"workspace-unsubscribe",id:l(d),payload:{subscriptionId:n}})}},Co=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=l(d);W.set(n,o);try{await x({...b,type:"shells-subscribe",id:l(d),payload:{subscriptionId:n,scope:t}})}catch(i){if(W.delete(n),!P)M({...b,type:"shells-unsubscribe",id:l(d),payload:{subscriptionId:n}});throw i}return()=>{if(!W.delete(n)||P)return;M({...b,type:"shells-unsubscribe",id:l(d),payload:{subscriptionId:n}})}},Te=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>je))throw new a("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!J(t.value))throw new a("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>ze)throw new a("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&c?.features?.deviceStorage!==!0)throw new a("UNSUPPORTED","This host does not support device storage.");let o=await v({...b,type:"storage",id:l(d),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new a("HOST_REJECTED","Host did not return storage data.");return o},Ft=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...b,type:"popover-close",id:l(d),payload:o?{id:t,reason:o}:{id:t}}),Ht=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new a("UNSUPPORTED","This host does not support popovers.")):x({...b,type:"popover-anchor",id:l(d),payload:{id:t,active:o}});return r.addEventListener("keydown",Nt,!0),r.addEventListener("pointerover",Se),r.addEventListener("pointermove",Se),r.addEventListener("pointerout",Pt),r.addEventListener("focus",Dt),r.addEventListener("blur",$t),{onAction:(t)=>(re=t,()=>{if(re===t)re=null}),listProjects:async()=>{let t=await Xe({kind:"projects"});if(t.kind!=="projects")throw new a("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Xe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new a("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Xe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new a("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Be({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Be({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Be({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Co(t,o),readShellOutput:async(t,o)=>{N(t,me);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new a("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let i=o?.tailBytes;if(i!==void 0&&(!Number.isInteger(i)||i<1||i>he))throw new a("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${he}.`);let _=await v({...b,type:"shell-output",id:l(d),payload:{shellId:t,cursor:n,tailBytes:i}});if(!_||typeof _.output!=="string"||!Number.isFinite(_.cursor))throw new a("HOST_REJECTED","Host did not return shell output.");return _},stopShell:async(t)=>{if(N(t,me),(await v({...b,type:"shell-stop",id:l(d),payload:{shellId:t}}))?.stopped!==!0)throw new a("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await x({...b,type:"open-session",id:l(d),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ie(o),i={op:"get",key:t};if(n)i.scope=n;let S=await Te(i);return S.op==="get"&&S.found?S.value:void 0},set:async(t,o,n)=>{let i=Ie(n),S={op:"set",key:t,value:o};if(i)S.scope=i;await Te(S)},delete:async(t,o)=>{let n=Ie(o),i={op:"delete",key:t};if(n)i.scope=n;await Te(i)},keys:async(t)=>{let o=Ie(t),n={op:"keys"};if(o)n.scope=o;let i=await Te(n);if(i.op!=="keys")throw new a("HOST_REJECTED","Expected storage keys.");return i.keys}},onReady:(t)=>{if(E.add(t),c)t(c);return()=>{E.delete(t)}},onDirectory:(t)=>{if(g.add(t),c)t(c.directory);return()=>{g.delete(t)}},onSession:(t)=>{if(G.add(t),c)t(c.session);return()=>{G.delete(t)}},onSessionLifecycle:(t)=>{if(y.add(t),D)t(D);return()=>{y.delete(t)}},onConnection:(t)=>{if(U.add(t),c)t(c.connection);return()=>{U.delete(t)}},onSettings:(t)=>{if(B.add(t),c)t(c.settings);return()=>{B.delete(t)}},onItem:(t)=>{if(te.add(t),c)t(c.item);return()=>{te.delete(t)}},onStatusControl:(t)=>(pe.add(t),()=>{pe.delete(t)}),onPopoverClosed:(t)=>(ue.add(t),()=>{ue.delete(t)}),setStatusControls:(t)=>{if(c?.features?.statusControls!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support status controls."));if(!Kt(t))return Promise.reject(new a("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return x({...b,type:"status-controls",id:l(d),payload:{controls:t}})},openPopover:(t)=>{if(c?.features?.popovers!==!0)return Promise.reject(new a("UNSUPPORTED","This host does not support popovers."));if(!Ye(t))return Promise.reject(new a("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return x({...b,type:"popover-open",id:l(d),payload:t})},closePopover:Ft,setPopoverAnchorActive:Ht,onResolve:(t)=>(oe=t,()=>{if(oe===t)oe=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Ae)return Promise.reject(new a("HOST_REJECTED",`Toast message must contain 1 to ${Ae} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>ke))return Promise.reject(new a("HOST_REJECTED",`Toast copy text must contain 1 to ${ke} characters.`));return x({channel:p,v:u,type:"toast",id:l(d),payload:{...t,message:o}})},openUrl:(t)=>x({channel:p,v:u,type:"open-url",id:l(d),payload:{url:t}}),openCommit:(t)=>et(t)?x({channel:p,v:u,type:"open-commit",id:l(d),payload:{sha:t}}):Promise.reject(new a("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>x({channel:p,v:u,type:"open-surface",id:l(d),payload:{surfaceId:t}}),writeClipboard:(t)=>x({channel:p,v:u,type:"clipboard-write",id:l(d),payload:{text:t}}),compose:(t)=>x({channel:p,v:u,type:"compose",id:l(d),payload:t}),attach:(t)=>x({channel:p,v:u,type:"attach",id:l(d),payload:Y(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await v({channel:p,v:u,type:"start-session",id:l(d),payload:nt(t)},e.requestTimeoutMs??180000);if(!Ze(n))throw new a("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>v({channel:p,v:u,type:"prompt",id:l(d),payload:st(t)}).then((o)=>{if(!qe(o))throw new a("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>x({channel:p,v:u,type:"session-link",id:l(d),payload:Y(t)}),close:()=>x({channel:p,v:u,type:"close",id:l(d)}),oauthStart:()=>x({channel:p,v:u,type:"oauth-start",id:l(d)}),oauthDisconnect:()=>x({channel:p,v:u,type:"oauth-disconnect",id:l(d)}),request:(t)=>(Re(t.path)?v({channel:p,v:u,type:"request",id:l(d),payload:t}):ho()).then((o)=>{if(!we(o))throw new a("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Re(t.path)?v({channel:p,v:u,type:"service-request",id:l(d),payload:t}):ho()).then((o)=>{if(!we(o))throw new a("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>v({channel:p,v:u,type:"service-status",id:l(d)}).then((t)=>{if(!ct(t))throw new a("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Q(t)?v({channel:p,v:u,type:"file-read",id:l(d),payload:{path:t}}):Ue()).then((o)=>{if(!dt(o))throw new a("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Q(t))return Ue();if(o.length>ye)return Promise.reject(new a("FILE_TOO_LARGE",`Content is over ${ye} characters.`));return v({channel:p,v:u,type:"file-write",id:l(d),payload:{path:t,content:o}}).then((n)=>{if(!lt(n))throw new a("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Q(t)?v({channel:p,v:u,type:"file-list",id:l(d),payload:{path:t}}):Ue()).then((o)=>{if(!pt(o))throw new a("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Q(t)?v({channel:p,v:u,type:"file-stat",id:l(d),payload:{path:t}}):Ue()).then((o)=>{if(!ut(o))throw new a("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>Oe)return Promise.reject(new a("HOST_REJECTED",`Prompt must be 1 to ${Oe} characters.`));if(n!==void 0&&(n.length===0||n.length>ve))return Promise.reject(new a("HOST_REJECTED",`System prompt must be 1 to ${ve} characters.`));let i=t.maxOutputTokens===void 0?void 0:Math.min(ot,Math.max(1,Math.floor(t.maxOutputTokens)));if(i!==void 0&&!Number.isFinite(i))return Promise.reject(new a("HOST_REJECTED","maxOutputTokens must be a number."));let S={prompt:o};if(n!==void 0)S.system=n;if(i!==void 0)S.maxOutputTokens=i;return v({channel:p,v:u,type:"generate",id:l(d),payload:S},e.requestTimeoutMs??rt).then((_)=>{if(!Et(_))throw new a("HOST_REJECTED","Host did not return generated text.");return _})},setBadge:(t)=>x({channel:p,v:u,type:"badge",id:l(d),payload:{count:it(t)}}),setHeight:(t)=>x({channel:p,v:u,type:"resize",id:l(d),payload:{height:at(t)}}),onFileOpen:(t)=>{if(Ee.add(t),!Fe)Fe=!0,r.addEventListener("keydown",Gt,!0);if(se)t(se);return()=>{Ee.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(fe.add(t),()=>{fe.delete(t)}),reportFileChange:(t)=>He({...b,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Lt,reportFileUnsupported:()=>He({...b,type:"file-unsupported"}),dispose:()=>{for(let t of K.keys())M({...b,type:"workspace-unsubscribe",id:l(d),payload:{subscriptionId:t}});K.clear();for(let t of W.keys())M({...b,type:"shells-unsubscribe",id:l(d),payload:{subscriptionId:t}});if(W.clear(),P=!0,oe=null,re=null,ne=null,Ee.clear(),fe.clear(),Fe)r.removeEventListener("keydown",Gt,!0);r.removeEventListener("message",Mt),r.removeEventListener("keydown",Nt,!0),r.removeEventListener("pointerover",Se),r.removeEventListener("pointermove",Se),r.removeEventListener("pointerout",Pt),r.removeEventListener("focus",Dt),r.removeEventListener("blur",$t);for(let t of z.values())clearTimeout(t.timer),t.reject(new a("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),E.clear(),g.clear(),G.clear(),y.clear(),U.clear(),B.clear(),te.clear(),pe.clear(),ue.clear()}}};var xo=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize"];var Ar=new Set(xo);var bo=["none","agent","user"];var gr=new Set(bo);var Ho=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Xo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Ao=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,f]of Ho)r.style.setProperty(s,e.tokens[f]);for(let[s,f,E]of Xo){let g=e.tokens[E]??"";r.style.setProperty(s,g),r.style.setProperty(f,g)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},St=(e,r)=>{if(Ao(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Bo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},m=(e,r)=>`var(--${e}, var(--oc-${Bo[e]}, ${r}))`,H=m("surface-background","transparent"),Me=m("surface-elevated","transparent"),Z=m("surface-elevated-foreground","inherit"),L=m("surface-foreground","inherit"),T=m("surface-muted-foreground","gray"),Vo=m("surface-muted","transparent"),V=m("interactive-border","currentColor"),R=m("interactive-hover","transparent"),j=m("interactive-active","transparent"),Tt=m("interactive-selection","transparent"),mt=m("interactive-selection-foreground","inherit"),F=m("primary","currentColor"),ht=m("primary-text","inherit"),xt=m("error-text","inherit"),jo=m("font-sans","inherit"),bt=m("font-mono","monospace"),vo=m("radius","9px"),At=`calc(${vo} - 2px)`,ko=`calc(${vo} - 4px)`,h=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,go=`background-image: linear-gradient(${R}, ${R});`,kt=(e)=>`box-shadow: inset 0 0 0 1px ${e}, var(--oc-sdk-field-lift);`,gt="box-shadow: inset 0 0 0 1px var(--oc-sdk-edge), var(--oc-sdk-raised-lift);",yo="box-shadow: var(--oc-sdk-lit);",Oo=`inset 0 1px 0 0 ${h(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2)`,zo=`
:root {
  --oc-sdk-edge: ${h(L,10)};
  --oc-sdk-field-bg: ${Me};
  --oc-sdk-raised-bg: ${H};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 2px 0 rgb(0 0 0 / 0.06);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.45), 0 1px 2px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.8), inset 0 0 0 1px rgb(0 0 0 / 0.04), 0 0 0 1px rgb(0 0 0 / 0.1), 0 1px 2px -0.5px rgb(0 0 0 / 0.08), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.08);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${h(L,6)};
  --oc-sdk-field-bg: ${h(H,50,Me)};
  --oc-sdk-raised-bg: ${Me};
  --oc-sdk-field-lift: ${Oo};
  --oc-sdk-raised-lift: ${Oo};
  --oc-sdk-lit: inset 0 1px 0 0 ${h(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.36), 0 1px 1px -0.5px rgb(0 0 0 / 0.22), 0 3px 3px -1.5px rgb(0 0 0 / 0.2), 0 6px 6px -3px rgb(0 0 0 / 0.16);
}`,Ce=(e)=>{let r=m(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${m(`${e}-text`,"inherit")}; }`},Ko=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: 6px; height: 28px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: 4px; height: 24px; padding: 0 8px; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: 8px 10px; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 28px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: 14px; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,Ro=`${zo}
.oc-sdk { color: ${L}; font-family: ${jo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${go} }
.oc-sdk-mono { font-family: ${bt}; }
.oc-sdk-muted { color: ${T}; }
${Ce("success")}${Ce("warning")}${Ce("error")}${Ce("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${ht}; }

.oc-sdk-btn { border-radius: ${At}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${ko}; }
.oc-sdk-btn[data-variant="default"] { color: ${ht}; background: ${h(F,10,H)}; border-color: ${h(F,12)}; ${yo} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${h(F,16,H)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${h(F,22,H)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Vo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${R}, ${R}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${Z}; border-color: transparent; ${gt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${R}, ${R}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: inset 0 0 0 1px var(--oc-sdk-edge); }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${R}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${m("status-error","red")}; color: ${xt}; background: ${h("var(--oc-sdk-tone)",7,H)}; border-color: ${h("var(--oc-sdk-tone)",12)}; ${yo} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${h("var(--oc-sdk-tone)",9,H)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${h("var(--oc-sdk-tone)",11,H)}; box-shadow: none; }

.oc-sdk-field-note { color: ${T}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${xt}; }
.oc-sdk-input { border-radius: ${At}; background: var(--oc-sdk-field-bg); color: ${Z}; ${kt("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${T}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${R}, ${R}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${kt(h(L,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${kt(m("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${bt}; }

.oc-sdk-search-icon { color: ${T}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${ko}; color: ${T}; }
.oc-sdk-search-clear:hover { background: ${R}; color: ${L}; }

.oc-sdk-trigger { border-color: transparent; border-radius: ${At}; background: var(--oc-sdk-raised-bg); color: ${Z}; ${gt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${R}, ${R}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${T}; }
.oc-sdk-trigger-chevron { color: ${T}; }
/* The app's dropdown light: lit top, hairline rings and a layered shadow, no border. */
.oc-sdk-popup { --surface-foreground: ${Z}; border-color: transparent; border-radius: 12px; background: ${Me}; color: ${Z}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${R}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Tt}; color: ${mt}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${xt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${h(m("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${T}; }
.oc-sdk-popup-empty { color: ${T}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${V}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${h(L,60,V)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${V}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${H}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${go} }
.oc-sdk-check-desc { color: ${T}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${h(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${T}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${mt}; background: ${Tt}; border-color: ${V}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${Z}; background: var(--oc-sdk-raised-bg); border-color: transparent; ${gt} }
.oc-sdk-tab-count { color: ${T}; }

.oc-sdk-badge { border-radius: 9999px; background: ${R}; color: ${T}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${h("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${R}; }
.oc-sdk-row[aria-selected="true"] { background: ${Tt}; color: ${mt}; }
.oc-sdk-row-lead { font-family: ${bt}; color: ${T}; }
.oc-sdk-row-sub { color: ${T}; }
.oc-sdk-row-meta { color: ${T}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${T}; }

.oc-sdk-empty-body { color: ${T}; }

.oc-sdk-spinner { color: ${T}; }
.oc-sdk-spinner-ring { border-color: ${V}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${h("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${T}; }

.oc-sdk-separator { color: ${T}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${h(V,40)}; }

.oc-sdk-progress-label { color: ${T}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${V}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }

.oc-sdk-text a { color: ${ht}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${h(V,60)}; }
`,w=`
${Ve}
${Ko}
${Ro}`;var vt=31,Zo=8,De=_t(),qo=document.getElementById("root"),de=[],Rt="loading",wt="",le=new Map,ee=new Map,Uo=(e)=>e.activity==="waiting-question"||e.activity==="waiting-permission",Io=(e)=>e.activity==="running"||e.activity==="retrying",wo=(e)=>!e.archivedAt&&!e.parentId,O=(e,r,s)=>{let f=document.createElement(e);if(r!==void 0)f.textContent=r;if(s)f.className=s;return f},er=(e)=>{if(Uo(e))return O("span",e.activity,"badge waiting");if(Io(e))return O("span",e.activity,"badge running");if(e.outcome==="failed")return O("span","failed","badge failed");return O("span",e.activity,"badge muted")},$e=()=>{let e=[...le.values()].flat().filter(wo),r=O("header");if(r.append(O("h1","Planner"),O("div",`${de.length} projects · ${e.filter(Io).length} running · ${e.filter(Uo).length} waiting for you`,"summary")),Rt!=="ready")r.append(O("p",Rt==="error"?"Some projects are unavailable.":"Loading projects…","muted"));if(de.length>vt)r.append(O("p",`Showing sessions for the first ${vt} projects.`,"muted"));if(wt)r.append(O("p",wt,"failed"));let s=de.map((f)=>{let E=O("section",void 0,"project");E.append(O("h2",f.name),O("div",f.directory,"muted"));let g=O("ul",void 0,"sessions"),G=(le.get(f.id)??[]).filter(wo).sort((y,U)=>U.updatedAt-y.updatedAt).slice(0,Zo);for(let y of G){let U=O("li");U.append(er(y),O("span",y.title)),U.addEventListener("click",()=>{De.openSession(y.id).catch(Ut)}),g.append(U)}if(G.length===0)g.append(O("li",le.has(f.id)?"No sessions":"Loading sessions…","muted"));return E.append(g),E});qo.replaceChildren(r,...s)},Ut=(e)=>{wt=e instanceof Error?e.message:String(e),$e()},tr=async()=>{let e=new Set(de.slice(0,vt).map((r)=>r.id));for(let[r,s]of ee){if(e.has(r))continue;s(),ee.delete(r),le.delete(r)}for(let r of e){if(ee.has(r))continue;ee.set(r,()=>{});let s=await De.onSessions(r,(f)=>{le.set(r,f.sessions),$e()});if(ee.has(r))ee.set(r,s);else s()}};De.onReady((e)=>{St(e,document.documentElement),$e()});De.onProjects((e)=>{de=e.projects,Rt=e.state,$e(),tr().catch(Ut)}).catch(Ut);})();
