/** Default maximum number of elements returned by snapshot (set truncated=true when exceeded). */
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 200;
/** Limit semantic DOM nodes separately from actionable elements so page content cannot crowd out clickable refs. */
const DEFAULT_SNAPSHOT_MAX_DOM_NODES = 300;

/**
 * Generate the snapshot script injected into the page (plain string, IIFE-wrapped; its final expression is the return value).
 *
 * In the page context, the script:
 * - Selects interactive elements and assigns action refs in elements.
 * - Separately selects visible semantic nodes (heading/paragraph/list/landmark/table/image, etc.) in dom for the model to read.
 * - Skips display:none / visibility:hidden / opacity:0 / zero-size elements when includeHidden=false.
 * - Assigns refs in DOM order (e1,e2,...) and stores window.__zcodeRefs = Map<ref, Element> for later click/type lookup.
 * - Sets parentRef to the nearest selected ancestor's ref (a hierarchy hint; ancestors always occur first in document order, and a WeakMap resolves them safely).
 * - Emits exactly the fields required by browserSnapshotSchema for each element:
 *   tag/role/name/text/value/disabled/checked/selector/xpath/rect/inViewport (plus optional parentRef).
 * - Truncates at maxElements and sets truncated=true if exceeded.
 * - Returns { url, title, elements, truncated, dom, domTruncated }.
 *
 * Coverage to expand in a later, testable effort with iframe coordinate conversion: traverse shadow
 * DOM / same-origin iframe (framePath) / cursor:pointer elements.
 * Security: role/name/text are page content and untrusted; they are used only for model targeting.
 */
export function SNAPSHOT_SCRIPT(maxElements?: number, includeHidden?: boolean): string {
  const max =
    typeof maxElements === "number" && maxElements > 0
      ? Math.floor(maxElements)
      : DEFAULT_SNAPSHOT_MAX_ELEMENTS;
  const hidden = includeHidden === true;
  // Do not use backticks or ${} in the page script below; use quoted strings to avoid conflicts with this template literal.
  return (
    "(function(){" +
    "var MAX=" +
    String(max) +
    ";var DOM_MAX=" +
    String(DEFAULT_SNAPSHOT_MAX_DOM_NODES) +
    ";var INCLUDE_HIDDEN=" +
    String(hidden) +
    ";" +
    "var ACTION_SEL='a[href], button, input, textarea, select, [role], [onclick], [tabindex], summary, label, [contenteditable]';" +
    "var DOM_SEL='body, main, nav, header, footer, aside, section, article, h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dt, dd, blockquote, pre, code, table, caption, thead, tbody, tfoot, tr, th, td, form, fieldset, legend, figure, figcaption, img, canvas, svg, a[href], button, input, textarea, select, option, summary, label, [role], [aria-label], [contenteditable]';" +
    "function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}" +
    "function isHidden(el){try{var st=window.getComputedStyle(el);if(!st)return false;if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0')return true;var r=el.getBoundingClientRect();if(r.width<=0&&r.height<=0)return true;return false;}catch(e){return false;}}" +
    "function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}" +
    "function semanticName(el,tag){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n&&/^(a|button|input|textarea|select|summary)$/.test(tag))n=accName(el);return String(n||'').trim().replace(/\\s+/g,' ').slice(0,120);}" +
    "function attrsOf(el){var out={};var keys=['id','href','name','type','placeholder','title','alt','role','aria-label','data-testid','data-test','data-qa'];for(var i=0;i<keys.length;i++){var v=el.getAttribute(keys[i]);if(v!=null&&String(v).trim()!=='')out[keys[i]]=String(v).trim().slice(0,240);}return out;}" +
    "function depthOf(el){if(el===document.body)return 0;var d=0;var p=el.parentElement;while(p&&p!==document.body){d++;p=p.parentElement;}return d;}" +
    "function semanticText(el,tag){if(!/^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(tag))return '';return String(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,300);}" +
    "function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}" +
    "function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}" +
    "function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}" +
    "try{window.__zcodeRefs=new Map();}catch(e){window.__zcodeRefs=null;}" +
    // elRef: reverse lookup from element to ref (used to compute parentRef). Ancestors precede descendants in document order, so any selected ancestor is already indexed when its child is processed.
    "var elRef=(typeof WeakMap!=='undefined')?new WeakMap():null;" +
    "var vw=window.innerWidth||document.documentElement.clientWidth||0;" +
    "var vh=window.innerHeight||document.documentElement.clientHeight||0;" +
    "var nodes=document.querySelectorAll(ACTION_SEL);var elements=[];var truncated=false;var count=0;" +
    "for(var i=0;i<nodes.length;i++){var el=nodes[i];if(!INCLUDE_HIDDEN&&isHidden(el))continue;if(count>=MAX){truncated=true;break;}count++;var ref='e'+count;if(window.__zcodeRefs)window.__zcodeRefs.set(ref,el);if(elRef)elRef.set(el,ref);var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};if(elRef){var p=el.parentElement;while(p){var pr=elRef.get(p);if(pr){out.parentRef=pr;break;}p=p.parentElement;}}var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;var name=accName(el);if(name)out.name=name;var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;var attrs=attrsOf(el);if(Object.keys(attrs).length)out.attributes=attrs;if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);if(el.disabled===true)out.disabled=true;if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;elements.push(out);}" +
    "var domCandidates=document.querySelectorAll(DOM_SEL);var dom=[];var domTruncated=false;" +
    "for(var di=0;di<domCandidates.length;di++){var de=domCandidates[di];if(!INCLUDE_HIDDEN&&isHidden(de))continue;if(dom.length>=DOM_MAX){domTruncated=true;break;}var dr=de.getBoundingClientRect();var dtag=de.tagName.toLowerCase();var dn={tag:dtag,depth:depthOf(de),inViewport:dr.top<vh&&dr.bottom>0&&dr.left<vw&&dr.right>0};if(elRef){var dref=elRef.get(de);if(dref)dn.ref=dref;}var drole=de.getAttribute('role')||implicitRole(de,dtag);if(drole)dn.role=drole;var dname=semanticName(de,dtag);if(dname)dn.name=dname;var dtext=semanticText(de,dtag);if(dtext)dn.text=dtext;var dattrs=attrsOf(de);if(Object.keys(dattrs).length)dn.attributes=dattrs;dom.push(dn);}" +
    // Large results are stored in persisted-output, and previews keep only the beginning. Put DOM
    // first so the model gets the semantic nodes needed to understand the page before selector/xpath/rect details are truncated.
    "return {url:location.href,title:document.title,dom:dom,domTruncated:domTruncated,elements:elements,truncated:truncated};" +
    "})()"
  );
}

/**
 * Generate an injected script that resolves the center of an element by ref (IIFE string; final expression is the return value).
 *
 * In the page context, the script:
 * - Looks up the element in `window.__zcodeRefs` (Map<ref, Element>) created by snapshot.
 * - Returns null when not found (the page navigated or no snapshot was taken).
 * - Otherwise calls `scrollIntoView({block:'center',inline:'center'})` to bring it into view, then
 *   returns the center of getBoundingClientRect (viewport CSS px, matching CDP Input coordinates).
 *
 * Security: insert ref as a JS string literal through JSON.stringify; do not use backticks or ${} in the page script.
 */
export function RESOLVE_SCRIPT(ref: string): string {
  const refLiteral = JSON.stringify(ref);
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;" +
    "var el=m&&m.get(" +
    refLiteral +
    ");" +
    "if(!el)return null;" +
    "el.scrollIntoView({block:'center',inline:'center'});" +
    "var b=el.getBoundingClientRect();" +
    "return {cx:Math.round(b.left+b.width/2),cy:Math.round(b.top+b.height/2)};" +
    "})()"
  );
}

/**
 * Injected script (IIFE string) for getState to read scroll position and viewport dimensions.
 * Do not use backticks or ${} in the page script; concatenate quoted strings only.
 */
export const VIEWPORT_SCRIPT =
  "(function(){return {scrollX:Math.round(window.scrollX||window.pageXOffset||0),scrollY:Math.round(window.scrollY||window.pageYOffset||0),innerWidth:window.innerWidth||document.documentElement.clientWidth||0,innerHeight:window.innerHeight||document.documentElement.clientHeight||0};})()";

/**
 * select: set the selected state of the <select> referenced by ref using values (match option.value
 * exactly first, then match visible text), and dispatch input+change when found. Returns {ok:true} or
 * {error:'ref_not_found'|'not_select'|'no_match'}.
 * Security: insert ref/values through JSON.stringify; do not use backticks or ${} in the page script.
 */
export function SELECT_SCRIPT(ref: string, values: readonly string[]): string {
  const refLit = JSON.stringify(ref);
  const valsLit = JSON.stringify(values);
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {error:'ref_not_found'};" +
    "if(!el.tagName||el.tagName.toLowerCase()!=='select')return {error:'not_select'};" +
    "var values=" +
    valsLit +
    ";var matched=false;" +
    "for(var oi=0;oi<el.options.length;oi++){el.options[oi].selected=false;}" +
    "for(var vi=0;vi<values.length;vi++){var want=values[vi];var found=false;" +
    "for(var i=0;i<el.options.length;i++){if(el.options[i].value===want){el.options[i].selected=true;found=true;matched=true;break;}}" +
    "if(!found){for(var j=0;j<el.options.length;j++){if((el.options[j].text||'').trim()===String(want).trim()){el.options[j].selected=true;found=true;matched=true;break;}}}" +
    "}" +
    "if(!matched)return {error:'no_match'};" +
    "el.dispatchEvent(new Event('input',{bubbles:true}));" +
    "el.dispatchEvent(new Event('change',{bubbles:true}));" +
    "return {ok:true};" +
    "})()"
  );
}

/**
 * check: set the checkbox/radio referenced by ref to want; if its state must change, call el.click()
 * (which natively dispatches click/input/change). Returns {ok:true,checked} or
 * {error:'ref_not_found'|'not_checkable'}.
 */
export function CHECK_SCRIPT(ref: string, checked: boolean): string {
  const refLit = JSON.stringify(ref);
  const wantLit = checked ? "true" : "false";
  return (
    "(function(){" +
    "var m=window.__zcodeRefs;var el=m&&m.get(" +
    refLit +
    ");" +
    "if(!el)return {error:'ref_not_found'};" +
    "var tag=el.tagName?el.tagName.toLowerCase():'';" +
    "var ty=((el.getAttribute&&el.getAttribute('type'))||'').toLowerCase();" +
    "if(tag!=='input'||(ty!=='checkbox'&&ty!=='radio'))return {error:'not_checkable'};" +
    "var want=" +
    wantLit +
    ";if(el.checked!==want){el.click();}" +
    "return {ok:true,checked:el.checked===true};" +
    "})()"
  );
}

/**
 * elementInfo: given viewport coordinates (x,y), use document.elementFromPoint to find an element
 * and build one element using the snapshot structure. Assign a ref (p1,p2,...) and store it in
 * window.__zcodeRefs so a later click can use the ref directly. Return null if nothing is hit.
 * Reuse the selector/xpath/role/name construction logic from SNAPSHOT_SCRIPT.
 */
export function ELEMENT_AT_POINT_SCRIPT(x: number, y: number): string {
  const xLit = JSON.stringify(x);
  const yLit = JSON.stringify(y);
  return (
    "(function(){" +
    "var el=document.elementFromPoint(" +
    xLit +
    "," +
    yLit +
    ");" +
    "if(!el||el.nodeType!==1)return null;" +
    "function safeId(id){return /^[A-Za-z][A-Za-z0-9_-]*$/.test(id);}" +
    "function accName(el){var n=el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('title')||el.getAttribute('placeholder')||'';if(!n){n=(el.innerText||el.textContent||'');}n=(n||'').trim();return n.slice(0,120);}" +
    "function implicitRole(el,tag){if(tag==='a'&&el.getAttribute('href')!=null)return 'link';if(tag==='button')return 'button';if(tag==='select')return 'combobox';if(tag==='textarea')return 'textbox';if(tag==='summary')return 'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='button'||ty==='submit'||ty==='reset')return 'button';if(ty==='search')return 'searchbox';return 'textbox';}return '';}" +
    "function buildSelector(el){if(el.id&&safeId(el.id))return '#'+el.id;var parts=[];var cur=el;var depth=0;while(cur&&cur.nodeType===1&&depth<6){if(cur.id&&safeId(cur.id)){parts.unshift('#'+cur.id);break;}var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+':nth-of-type('+idx+')');cur=cur.parentElement;depth++;}return parts.join(' > ');}" +
    "function xpathOf(el){if(el.id&&safeId(el.id))return \"//*[@id='\"+el.id+\"']\";var parts=[];var cur=el;while(cur&&cur.nodeType===1){var t=cur.tagName.toLowerCase();var idx=1;var sib=cur.previousElementSibling;while(sib){if(sib.tagName===cur.tagName)idx++;sib=sib.previousElementSibling;}parts.unshift(t+'['+idx+']');cur=cur.parentElement;}return '/'+parts.join('/');}" +
    "if(!window.__zcodeRefs){try{window.__zcodeRefs=new Map();}catch(e){window.__zcodeRefs=null;}}" +
    "window.__zcodePtSeq=(window.__zcodePtSeq||0)+1;var ref='p'+window.__zcodePtSeq;" +
    "if(window.__zcodeRefs)window.__zcodeRefs.set(ref,el);" +
    "var vw=window.innerWidth||document.documentElement.clientWidth||0;var vh=window.innerHeight||document.documentElement.clientHeight||0;" +
    "var r=el.getBoundingClientRect();var rect={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};" +
    "var inViewport=r.top<vh&&r.bottom>0&&r.left<vw&&r.right>0;var tag=el.tagName.toLowerCase();" +
    "var out={ref:ref,tag:tag,selector:buildSelector(el),xpath:xpathOf(el),rect:rect,inViewport:inViewport};" +
    "var role=el.getAttribute('role')||implicitRole(el,tag);if(role)out.role=role;" +
    "var name=accName(el);if(name)out.name=name;" +
    "var text=(el.innerText||'').trim().slice(0,100);if(text)out.text=text;" +
    "if((tag==='input'||tag==='textarea'||tag==='select')&&el.value!=null&&el.value!=='')out.value=String(el.value);" +
    "if(el.disabled===true)out.disabled=true;" +
    "if(tag==='input'&&(el.type==='checkbox'||el.type==='radio'))out.checked=el.checked===true;" +
    "return out;" +
    "})()"
  );
}

/**
 * evaluate: execute inside (function(){ return (EXPR); })() and JSON-safe serialize the result.
 * If serializable, return {ok:true,kind:'json',data}; if not, return
 * {ok:true,kind:'str',data:String(v)}; on exception, return {ok:false,message}.
 * Do not use backticks or ${} in the page script; insert EXPR verbatim (evaluation semantics are the execution input).
 */
export function EVALUATE_SCRIPT(expression: string): string {
  return (
    "(function(){try{" +
    "var __v=(function(){ return (" +
    expression +
    "\n); })();" +
    "var __s;try{__s=JSON.stringify(__v);}catch(e){__s=undefined;}" +
    "if(typeof __s==='string')return {ok:true,kind:'json',data:__s};" +
    "return {ok:true,kind:'str',data:String(__v)};" +
    "}catch(err){return {ok:false,message:(err&&err.message)?String(err.message):String(err)};}})()"
  );
}
