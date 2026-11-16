/* PageAgo: local-only activity on one zoomable, pannable time axis. */
(() => {
  'use strict';
  const $=s=>document.querySelector(s);
  const el=(tag,cls,value)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=value;return n;};
  const icon=id=>{const n=document.createElementNS('http://www.w3.org/2000/svg','svg'),u=document.createElementNS(n.namespaceURI,'use');u.setAttribute('href','#i-'+id);n.append(u);return n;};
  const isExtension=!!(globalThis.chrome?.runtime?.id&&location.protocol==='chrome-extension:');
  const embedded=new URLSearchParams(location.search).get('embed')==='timeline';
  if(embedded)document.documentElement.dataset.embed='timeline';
  const splitLabels=!embedded&&document.documentElement.dataset.labelLayout==='split';
  // These names only improve display labels; grouping and colors work for any site.
  const knownNames={'github.com':'GitHub','arxiv.org':'arXiv','chatgpt.com':'ChatGPT','figma.com':'Figma','linear.app':'Linear','apple.com':'Apple','youtube.com':'YouTube','notion.so':'Notion','huggingface.co':'Hugging Face','bilibili.com':'哔哩哔哩','101weiqi.com':'101围棋网','zhihu.com':'知乎'};
  const siteCache=new Map();
  const colorRegistries=new Map();let preparedColorData=null,preparedColorScope='';
  let data={schema:'trace.v1',sessions:[],recording:false,status:'paused'},mode=isExtension?'live':'demo';
  let liveRecorder={recording:false,status:'paused'},lastLiveSignature='',date='',daySessions=[],filtered=[],pages=[],selected=null,lastFocus=null;
  const view=[0,1440];
  const laneMap=new Map(),tagMap=new Map();let rangeStart=0,rangeEnd=1;
  const titleMeasure=document.createElement('canvas').getContext('2d');
  const smoothLabel=value=>{const p=Math.max(0,Math.min(1,value));return p*p*(3-2*p);};
  const BAR_HEIGHT=32;
  const sessionStacks=[];
  let stackHeight=BAR_HEIGHT,stackTop=0;
  const camera={start:0,end:1,frame:0,last:0,targetStart:0,targetEnd:1,velocityStart:0,velocityEnd:0,lockAt:null};
  let wheelZoomTarget=null;
  let tagMotionFrame=0,tagMotionTime=0,tagMotionPaused=false;
  const room = embedded ? null : TraceDaylightRoom.create({canvas: $('#daylight-canvas')});
  let lockedTime = null, roomMinute = 9 * 60, scrubOrigin = null;
  const hourDial = TraceHourDial.create({
    root: $('#hour-dial'),
    onPreview(value, moving) {
      stopNavigation();
      const instant = hourInstant(value);
      if (moving) {
        scrubOrigin ??= [camera.start, camera.end];
        moveCameraWindow(...hourWindow(instant), false);
      }
      showHourMarker(instant);
      room?.setMinute(hourMinute(instant));
    },
    onCancel() {
      if (scrubOrigin) moveCameraWindow(...scrubOrigin, false);
      scrubOrigin = null;
      showHourMarker(lockedTime);
      room?.setMinute(roomMinute);
    },
    onCommit(value) {
      const instant = hourInstant(value);
      scrubOrigin = null;
      stopNavigation();
      if (selected) {
        closeDetail();
        $('.hour-dial-track').focus({preventScroll:true});
      }
      updateCamera(...hourWindow(instant), false, instant);
    },
    onWheelZoom(value, event) {
      if (!date) return;
      if (navigator.userActivation?.hasBeenActive) dial.unlock();
      zoomCamera(wheelZoomFactor(event), {dialInstant: hourInstant(value),wheel:true});
    }
  });
  const MIN_SPAN=30*60000;
  let navigationPaint=0;
  let probePoint=null,probeSession=null;
  const probe=$('#time-probe'),probeBadge=$('#probe-badge'),probeTime=$('#probe-time');
  const probePage=$('#probe-page'),probeTitle=$('#probe-title');
  let hiddenPages=[];
  let dateControl,pageHighlight,dateMotion,daySearch;
  const dial=window.TraceDialAudio;
  const detail={p:0,v:0,target:0,frame:0,last:0};
  let originalView=null,returningTo=null;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const today=()=>key(new Date());
  const isDemo=()=>mode==='demo'||data.source==='synthetic-demo';
  const latestDate=value=>value.sessions.length?key(new Date(value.sessions.reduce((a,s)=>Math.max(a,Date.parse(s.start)),0))):today();
  function key(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  const localDate = d => new Date(d+'T00:00:00');
  function dayBounds(d){const start=localDate(d);const end=new Date(start);end.setDate(end.getDate()+1);return [+start,+end];}
  function shift(d,n){const t=localDate(d);t.setDate(t.getDate()+n);return key(t);}
  const minute = t => {const d=new Date(t);return d.getHours()*60+d.getMinutes()+d.getSeconds()/60;};
  const time = t => new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
  const axisTime = n => `${String(Math.floor(n/60)).padStart(2,'0')}:${String(Math.round(n%60)).padStart(2,'0')}`;
  function duration(ms){const mins=Math.floor(ms/60000);if(mins<1)return ms>0?'不足 1 分':'0 分';return mins>=60?`${Math.floor(mins/60)} 小时${mins%60?' '+mins%60+' 分':''}`:`${mins} 分`;}
  function siteIdentity(host){
    const normalized=host.toLowerCase().replace(/\.$/,'');
    if(siteCache.has(normalized))return siteCache.get(normalized);
    // Bundled PSL data handles co.uk and independent github.io tenants locally.
    // IP addresses and single-label hosts keep their complete normalized host.
    const domain=tldts.getDomain(normalized,{extractHostname:false,allowPrivateDomains:true})||normalized;
    const meta={name:knownNames[domain]||domain,domain};
    siteCache.set(normalized,meta);if(siteCache.size>1024)siteCache.delete(siteCache.keys().next().value);
    return meta;
  }
  function siteColors(scope=mode==='live'?'live':isDemo()?'demo':'import'){
    if(!colorRegistries.has(scope)){
      let storage;try{storage=globalThis.localStorage;}catch{}
      colorRegistries.set(scope,TraceSiteColors.create({storage,key:'trace.site-colors.v1.'+scope}));
    }
    return colorRegistries.get(scope);
  }
  function prepareSiteColors(){
    const scope=mode==='live'?'live':isDemo()?'demo':'import';
    if(preparedColorData===data&&preparedColorScope===scope)return;
    const domains=[...new Set(data.sessions.map(s=>siteIdentity(s.host).domain))];
    siteColors(scope).prepare(domains);preparedColorData=data;preparedColorScope=scope;
  }
  function siteMeta(host){const meta=siteIdentity(host);return {...meta,color:siteColors().color(meta.domain)};}
  const faviconCache=new Map();let missingFavicon;
  function bundledIcon(host){
    const normalized=host.toLowerCase().replace(/\.$/,'');
    const domain=Object.keys(window.TRACE_ICONS).sort((a,b)=>b.length-a.length).find(d=>normalized===d||normalized.endsWith('.'+d));
    return domain?window.TRACE_ICONS[domain]?.data_url:null;
  }
  function cachedFavicon(pageUrl){
    const url=new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl',pageUrl);url.searchParams.set('size','32');url.searchParams.set('fallbackToHost','1');
    return new Promise(resolve=>{
      const img=new Image(),finish=value=>{clearTimeout(timer);img.onload=img.onerror=null;resolve(value);};
      const timer=setTimeout(()=>finish(null),4000);
      img.onload=()=>{
        try{const canvas=document.createElement('canvas');canvas.width=canvas.height=32;canvas.getContext('2d').drawImage(img,0,0,32,32);finish(canvas.toDataURL('image/png'));}
        catch{finish(null);}
      };
      img.onerror=()=>finish(null);img.src=url.href;
    });
  }
  function browserIcon(pageUrl){
    if(!isExtension||!pageUrl)return Promise.resolve(null);
    let parsed;try{parsed=new URL(pageUrl);}catch{return Promise.resolve(null);}
    if(!['http:','https:'].includes(parsed.protocol))return Promise.resolve(null);
    if(faviconCache.has(pageUrl))return faviconCache.get(pageUrl);
    // This sentinel goes only to the extension's local favicon endpoint, never to DNS or a website.
    missingFavicon??=cachedFavicon('https://trace-favicon-unavailable.invalid/');
    const result=Promise.all([cachedFavicon(pageUrl),missingFavicon]).then(([actual,fallback])=>actual&&actual!==fallback?actual:null);
    faviconCache.set(pageUrl,result);if(faviconCache.size>512)faviconCache.delete(faviconCache.keys().next().value);
    return result;
  }
  function siteIcon(host,pageUrl){
    const m=siteMeta(host),node=el('span','site-icon');node.setAttribute('aria-hidden','true');
    const placeholder=()=>{node.replaceChildren(document.createTextNode(m.name.slice(0,1).toUpperCase()));node.dataset.iconSource='placeholder';node.style.color='var(--tone,'+m.color+')';};
    const display=(src,source)=>{const img=el('img');img.alt='';img.decoding='async';img.onerror=placeholder;img.src=src;node.replaceChildren(img);node.dataset.iconSource=source;};
    const bundled=bundledIcon(host);if(bundled)display(bundled,'bundled');else placeholder();
    browserIcon(pageUrl).then(src=>{if(src&&node.isConnected)display(src,'browser-cache');});
    return node;
  }
  function sumUnion(items){const a=items.map(s=>[s.a,s.b]).sort((a,b)=>a[0]-b[0]);let total=0,start=0,end=0;for(const [x,y] of a){if(x>end){total+=end-start;start=x;end=y;}else end=Math.max(end,y);}return total+end-start;}
  function validate(raw){
    if(!raw||raw.schema!=='trace.v1'||!Array.isArray(raw.sessions))throw Error('需要 PageAgo 导出的 trace.v1 JSON 文件。');
    if(raw.sessions.length>100000)throw Error('文件超过 100,000 段，请按日期拆分。');
    const seen=new Set();
    const sessions=raw.sessions.map((s,i)=>{let u;try{u=new URL(s.url);}catch{throw Error(`第 ${i+1} 段网址无效。`);}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error(`第 ${i+1} 段网址不受支持。`);
      const a=Date.parse(s.start),b=Date.parse(s.end);if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b-a>86400000*2)throw Error(`第 ${i+1} 段时间无效。`);
      if(typeof s.title!=='string'||s.title.length>20000||s.url.length>40000)throw Error(`第 ${i+1} 段内容无效。`);
      const id=String(s.id??i);if(seen.has(id))throw Error('文件包含重复记录 ID。');seen.add(id);
      return {id,url:u.href,title:s.title,start:new Date(a).toISOString(),end:new Date(b).toISOString(),host:u.hostname};});
    return {...raw,schema:'trace.v1',sessions};
  }
  function derive(){
    prepareSiteColors();
    const [start,end]=dayBounds(date),v0=new Date(start),v1=new Date(start);v0.setMinutes(view[0]);v1.setMinutes(view[1]);
    if(rangeStart!==+v0||rangeEnd!==+v1){
      clearOriginalView();
      stopNavigation();camera.start=+v0;camera.end=+v1;
      resetHourDial(720);
      roomMinute = 9 * 60;
      room?.setMinute(roomMinute);
    }
    rangeStart=+v0;rangeEnd=+v1;
    daySessions=data.sessions.filter(s=>Date.parse(s.end)>start&&Date.parse(s.start)<end).map(s=>({...s,a:Math.max(start,Date.parse(s.start)),b:Math.min(end,Date.parse(s.end))}));
    filtered=daySessions.map(s=>({...s,a:Math.max(s.a,+v0),b:Math.min(s.b,+v1)})).filter(s=>s.b>s.a).sort((a,b)=>a.a-b.a||Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
    const groups=new Map();
    sessionStacks.length=0;
    for(const s of filtered){
      let stack=sessionStacks.findIndex(items=>items[items.length-1].b<=s.a);
      if(stack<0){stack=sessionStacks.length;sessionStacks.push([]);}
      s.stack=stack;sessionStacks[stack].push(s);
      if(!groups.has(s.url))groups.set(s.url,{url:s.url,host:s.host,title:s.title,items:[],...siteMeta(s.host)});groups.get(s.url).items.push(s);
    }
    const stackCount=Math.max(1,sessionStacks.length);
    stackHeight=stackCount===1?BAR_HEIGHT:Math.min(14,44/stackCount);
    stackTop=(BAR_HEIGHT-stackCount*stackHeight)/2;
    pages=[...groups.values()];
  }
  function visitTime(t){
    if(t===rangeEnd)return '24:00:00';
    const d=new Date(t);
    return [d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
  }
  function spanTime(a,b){
    if(new Date(a).getTimezoneOffset()===new Date(b).getTimezoneOffset())return `${visitTime(a)} — ${visitTime(b)}`;
    const withOffset=t=>{
      const offset=-new Date(t).getTimezoneOffset(),minutes=Math.abs(offset);
      const hoursText=String(Math.floor(minutes/60)).padStart(2,'0'),minutesText=String(minutes%60).padStart(2,'0');
      return `${visitTime(t).replace(/:00$/,'')} UTC${offset>=0?'+':'−'}${hoursText}:${minutesText}`;
    };
    return `${withOffset(a)} — ${withOffset(b)}`;
  }
  function timePosition(t){return (t-camera.start)/(camera.end-camera.start)*100;}
  function render(){dateMotion?.finish();closeOverflow();hideTimeProbe();$('#tooltip').hidden=true;derive();renderAxis();renderLanes();renderTags();renderStatus();dateControl?.update(date);if(selected)renderInspector();daySearch.refresh();}
  function renderAxis(){
    document.title='PageAgo · '+date;
    renderTicks();
    $('#scene').setAttribute('aria-label',`${date}，${pages.length} 个网页，前台活动 ${duration(sumUnion(filtered))}`);
    $('#timeline-nav').setAttribute('aria-disabled',!filtered.length);
  }
  function renderTicks(){
    const axis=$('#axis-ticks'),span=camera.end-camera.start,width=$('#lanes').clientWidth;
    const divisions=Math.max(2,Math.floor(width/135));
    const step=([1,2,5,10,15,30,60,120,180,240,360,720,1440].find(n=>n*60000>=span/divisions)||1440)*60000;
    const dayStart=dayBounds(date)[0],values=[camera.start];
    if(Math.abs(span-(rangeEnd-rangeStart))<1){
      const minuteStep=[60,120,180,240,360,720,1440].find(n=>n>=(view[1]-view[0])/divisions)||1440;
      for(let m=Math.ceil(view[0]/minuteStep)*minuteStep;m<view[1];m+=minuteStep){if(m<=view[0])continue;const t=localDate(date);t.setMinutes(m);values.push(+t);}
    }else for(let t=dayStart+Math.ceil((camera.start-dayStart)/step)*step;t<camera.end;t+=step){
      if((t-camera.start)/span*width>65&&(camera.end-t)/span*width>65)values.push(t);
    }
    values.push(camera.end);axis.replaceChildren();
    for(const t of values){const n=el('span','tick',t===dayBounds(date)[1]?'24:00':time(t));n.style.left=timePosition(t)+'%';axis.append(n);}
    const minorStep=([1,2,5,10,15,30,60,120,180,360,720].find(n=>n*60000>=span/Math.max(2,Math.floor(width/18)))||720)*60000;
    const marks=new Map(values.map(t=>[t,true])),fragment=document.createDocumentFragment();
    for(let t=dayStart+Math.ceil((camera.start-dayStart)/minorStep)*minorStep;t<camera.end;t+=minorStep)if(!marks.has(t))marks.set(t,false);
    for(const [t,major] of [...marks].sort((a,b)=>a[0]-b[0])){
      const mark=el('span','ruler-tick'+(major?' is-major':''));mark.style.left=timePosition(t)+'%';fragment.append(mark);
    }
    $('#axis-graduations').replaceChildren(fragment);
    const zoom=(rangeEnd-rangeStart)/span;$('#zoom-reset').textContent=(zoom<1.05?'1':zoom.toFixed(1).replace(/\.0$/,''))+'×';
    $('#hour-dial-reset').toggleAttribute('data-at-noon', isFullDay() && lockedTime === null);
    $('#zoom-out').disabled=zoom<1.0001;$('#zoom-in').disabled=span<=MIN_SPAN+1;$('#scene').classList.toggle('zoomed',zoom>1.0001);
  }
  function hideTimeProbe() {
    probePoint = null;
    probe.hidden = true;
    for (const tick of $('#axis-ticks').children) tick.classList.remove('probe-covered');
  }
  function sessionUnderPointer(instant,trackY){
    const row=sessionStacks[Math.floor((trackY-stackTop)/stackHeight)];
    if(!row)return null;
    // Each visual row is time-ordered and contains disjoint intervals.
    let lo=0,hi=row.length;
    while(lo<hi){
      const mid=Math.floor((lo+hi)/2);
      if(row[mid].b<=instant)lo=mid+1;
      else hi=mid;
    }
    const session=row[lo];
    return session&&session.a<=instant?session:null;
  }
  function showProbePage(session){
    if(session===probeSession)return;
    probeSession=session;
    probePage.hidden=!session;
    if(!session){probeTitle.textContent='';probePage.replaceChildren(probeTitle);return;}
    probeTitle.textContent=session.title.trim()||siteIdentity(session.host).name;
    probePage.replaceChildren(siteIcon(session.host,session.url),probeTitle);
  }
  function paintTimeProbe(){
    for(const tick of $('#axis-ticks').children)tick.classList.remove('probe-covered');
    if(!probePoint || document.hidden){probe.hidden=true;return;}
    const plot=$('#lanes').getBoundingClientRect(),axis=$('#axis').getBoundingClientRect();
    const {x,y}=probePoint;
    if(!plot.width || x<plot.left || x>plot.right || y<axis.top-14 || y>axis.top+82){probe.hidden=true;return;}
    const instant=Math.round(camera.start+(x-plot.left)/plot.width*(camera.end-camera.start));
    probe.style.left=x-axis.left+'px';probe.dataset.instant=String(instant);
    probeTime.textContent=visitTime(instant);
    showProbePage(sessionUnderPointer(instant,y-plot.top));
    probeBadge.style.maxWidth=plot.width+'px';
    probe.hidden=false;
    // Only the badge moves at the edges. The line always marks the true instant.
    const labelWidth=probeBadge.offsetWidth,left=Math.max(plot.left,Math.min(plot.right-labelWidth,x-labelWidth/2));
    probeBadge.style.transform=`translateX(${left-x}px)`;
    for(const tick of $('#axis-ticks').children){const rect=tick.getBoundingClientRect();tick.classList.toggle('probe-covered',rect.right>left-6&&rect.left<left+labelWidth+6);}
  }
  function renderLanes(){
    const liveUrls=new Set(pages.map(p=>p.url));
    for(const [url,row] of laneMap)if(!liveUrls.has(url)){row.node.remove();laneMap.delete(url);}
    for(const page of pages){
      let row=laneMap.get(page.url);
      if(!row){const node=el('div','lane');node.inert=true;node.setAttribute('aria-hidden','true');row={node,blocks:new Map()};laneMap.set(page.url,row);$('#lanes').append(node);}
      row.page=page;row.node.dataset.url=page.url;row.node.dataset.site=page.domain;row.node.style.setProperty('--tone',page.color);
      const ids=new Set(page.items.map(s=>s.id));for(const [id,block] of row.blocks)if(!ids.has(id)){block.remove();row.blocks.delete(id);}
      for(const s of page.items){
        let block=row.blocks.get(s.id);
        if(!block){block=el('span','block');block.dataset.session=s.id;row.node.append(block);row.blocks.set(s.id,block);}
        block.segment=s;positionBlock(block);block.style.setProperty('--tone',page.color);
        block.style.setProperty('--stack-offset',(stackTop+s.stack*stackHeight)+'px');block.style.setProperty('--stack-scale',stackHeight/BAR_HEIGHT);
      }
    }
    paintSticky();
  }
  function renderTags(){
    const urls=new Set(pages.map(page=>page.url));
    for(const [url,item] of tagMap)if(!urls.has(url)){item.button.remove();item.link.remove();item.anchor.remove();tagMap.delete(url);}
    for(const page of pages){
      let item=tagMap.get(page.url);
      if(!item){
        const button=el('button','event-tag'),name=el('span','event-name');button.dataset.url=page.url;button.append(siteIcon(page.host,page.url),name);
        const link=document.createElementNS('http://www.w3.org/2000/svg','path');link.classList.add('event-link');link.dataset.url=page.url;
        const anchor=document.createElementNS('http://www.w3.org/2000/svg','circle');anchor.classList.add('event-anchor');anchor.dataset.url=page.url;anchor.setAttribute('r','3');
        item={button,name,link,anchor,page};tagMap.set(page.url,item);$('#event-tags').append(button);$('#event-links').append(link,anchor);
        button.onclick=()=>activatePage(item.page);
        button.onmouseenter=e=>showTagTooltip(e,item.page);button.onmousemove=moveTooltip;button.onmouseleave=()=>$('#tooltip').hidden=true;
        button.onfocus=()=>{const rect=button.getBoundingClientRect();showTagTooltip({clientX:rect.x,clientY:rect.bottom},item.page);};button.onblur=()=>$('#tooltip').hidden=true;
      }
      item.page=page;const title=page.title||page.host;if(item.name.textContent!==title){item.name.textContent=title;item.textWidth=null;}item.button.title=page.title||page.url;
      item.button.setAttribute('aria-label',`${page.title||page.host}，前台活动合计 ${duration(sumUnion(page.items))}，查看详情`);
      for(const node of [item.button,item.link,item.anchor]){node.dataset.site=page.domain;node.style.setProperty('--tone',page.color);}
    }
    layoutTags();
  }
  function paintTagPose(item){
    const pose=item.pose,layout=item.tagLayout;
    if(!pose||!layout||item.button.hidden)return;
    const left=Math.max(0,Math.min(layout.plotWidth-layout.width,layout.anchor+pose.x));
    const dx=left-layout.left,dy=pose.y-layout.top;
    if(Math.abs(dx)<.001&&Math.abs(dy)<.001)item.button.style.removeProperty('translate');
    else item.button.style.translate=`${dx}px ${dy}px`;
    const moving=Math.abs(pose.x-pose.targetX)>.05||Math.abs(pose.y-pose.targetY)>.05||Math.abs(pose.vx)>.1||Math.abs(pose.vy)>.1;
    item.button.toggleAttribute('data-reflow',moving);
    // The timeline end stays at the actual visit time; the other end follows
    // the presented label. Never draw a detached line during a visit handoff.
    item.link.style.visibility=layout.anchor>=left-.5&&layout.anchor<=left+layout.width+.5?'':'hidden';
    item.link.setAttribute('d',layout.below
      ?`M ${layout.anchor} 294 V 299 M ${layout.anchor} 344 V ${260+pose.y}`
      :`M ${layout.anchor} ${pose.y+32+260} L ${layout.anchor} 252`);
    return moving;
  }
  function finishTagMotion(){
    cancelAnimationFrame(tagMotionFrame);tagMotionFrame=0;
    for(const item of tagMap.values())if(item.pose){
      item.pose.x=item.pose.targetX;item.pose.y=item.pose.targetY;item.pose.vx=item.pose.vy=0;
      paintTagPose(item);
    }
  }
  function startTagMotion(){
    if(tagMotionFrame)return;
    tagMotionTime=performance.now();
    const frame=now=>{
      tagMotionFrame=0;
      const dt=Math.min(.04,Math.max(0,(now-tagMotionTime)/1000)),omega=26,decay=Math.exp(-omega*dt);
      tagMotionTime=now;let moving=false;
      for(const item of tagMap.values()){
        const pose=item.pose;if(!pose||item.button.hidden)continue;
        for(const [axis,target,speed] of [['x','targetX','vx'],['y','targetY','vy']]){
          const delta=pose[axis]-pose[target],slope=pose[speed]+omega*delta;
          pose[axis]=pose[target]+(delta+slope*dt)*decay;
          pose[speed]=(pose[speed]-omega*slope*dt)*decay;
          if(Math.abs(pose[axis]-pose[target])<.05&&Math.abs(pose[speed])<.1){pose[axis]=pose[target];pose[speed]=0;}
        }
        moving=paintTagPose(item)||moving;
      }
      if(moving)tagMotionFrame=requestAnimationFrame(frame);
    };
    tagMotionFrame=requestAnimationFrame(frame);
  }
  function placeTag(item,layout,animate){
    const targetX=layout.left-layout.anchor,old=item.pose;
    if(!animate||!item.wasVisible||!old||reduced.matches||document.hidden||tagMotionPaused){
      item.pose={x:targetX,y:layout.top,vx:0,vy:0,targetX,targetY:layout.top,anchor:layout.anchor,session:layout.session};
    }else{
      // A later visit of the same URL can become its visible time anchor.
      // Rebase from the current position rather than teleporting to that visit.
      if(old.session!==layout.session)old.x+=old.anchor-layout.anchor;
      else if(old.targetY===layout.top&&item.tagLayout?.before===layout.before&&item.tagLayout?.after===layout.after){
        // The camera already moves continuously. Transport ordinary cell motion
        // directly; only discrete reflow retains a spring offset to settle.
        old.x+=targetX-old.targetX;
      }
      old.targetX=targetX;old.targetY=layout.top;old.anchor=layout.anchor;old.session=layout.session;
    }
    item.tagLayout=layout;item.button.style.left=layout.left+'px';item.button.style.top=layout.top+'px';
    if(paintTagPose(item))startTagMotion();
  }
  function layoutTags(animate=false){
    if(!animate)finishTagMotion();
    const width=$('#lanes').clientWidth,svg=$('#event-links'),more=$('#more-pages');
    const iconWidth=32,gap=6,overflowWidth=70;
    const rowPitch=iconWidth+10, firstRowTop=30+iconWidth;
    // In a widget, reserve space only for rows that fit above the ruler.
    const levels=embedded ? Math.max(1,Math.min(8,1+Math.floor(($('#scene').offsetTop-firstRowTop-12)/rowPitch))) : 8;
    for(const item of tagMap.values()){item.wasVisible=!item.button.hidden;item.button.hidden=true;item.link.style.display='none';item.anchor.style.display='none';}
    const entries=[];
    for(const page of pages){
      const item=tagMap.get(page.url),session=page.items.find(s=>s.b>camera.start&&s.a<camera.end);
      if(!item||!session)continue;
      const anchor=timePosition(Math.max(camera.start,session.a))/100*width;
      entries.push({item,anchor,session:session.id,iconLeft:Math.max(0,Math.min(width-iconWidth,anchor-iconWidth/2))});
      item.button.hidden=false;
    }
    // Measure natural width independently of the allocated label space.
    // Title length still never decides which icons fit.
    const unmeasured=entries.filter(({item})=>item.textWidth==null);
    // Labels keep a fixed font while zooming. Reading computed style after
    // hiding/showing every tag would force a fresh layout on every frame.
    if(unmeasured.length)titleMeasure.font=getComputedStyle(unmeasured[0].item.name).font;
    for(const {item} of unmeasured)item.textWidth=Math.ceil(titleMeasure.measureText(item.name.textContent).width)+1;
    entries.sort((a,b)=>a.anchor-b.anchor||a.item.page.url.localeCompare(b.item.page.url));
    svg.setAttribute('viewBox',`0 0 ${width} 280`);svg.setAttribute('width',width);svg.setAttribute('height',280);
    function arrange(reserve){
      const bands=Array.from({length:levels},()=>[]),hidden=[],pending=[];
      const valid=level=>Number.isInteger(level)&&level>=0&&level<levels;
      function slot(entry,level){
        const band=bands[level],limit=reserve&&level===0?Math.max(0,width-overflowWidth-gap):width;
        let index=0;while(index<band.length&&band[index].iconLeft<=entry.iconLeft)index++;
        if(entry.iconLeft<0||entry.iconLeft+iconWidth>limit)return -1;
        if(index&&entry.iconLeft<band[index-1].iconLeft+iconWidth+gap)return -1;
        if(index<band.length&&entry.iconLeft+iconWidth+gap>band[index].iconLeft)return -1;
        return index;
      }
      const insert=(entry,level,index)=>bands[level].splice(index,0,{...entry,level});
      // Reserve incumbents before admitting newly exposed pages. Otherwise an
      // early-time overflow item can steal a moving label's row, then release it
      // a few frames later, producing A -> B -> A during a single zoom gesture.
      for(const entry of entries){
        const level=entry.item.level,index=entry.item.wasVisible&&valid(level)?slot(entry,level):-1;
        if(index>=0)insert(entry,level,index);else pending.push(entry);
      }
      for(const entry of pending){
        const preferred=entry.item.level,order=Array.from({length:levels},(_,level)=>level);
        if(valid(preferred))order.sort((a,b)=>Math.abs(a-preferred)-Math.abs(b-preferred)||a-b);
        const level=order.find(level=>slot(entry,level)>=0);
        if(level===undefined)hidden.push(entry.item);else insert(entry,level,slot(entry,level));
      }
      return {bands,hidden,reserve};
    }
    let result=arrange(false);if(result.hidden.length)result=arrange(true);
    const zoom=(rangeEnd-rangeStart)/(camera.end-camera.start);
    const logZoom=Math.log2(Math.max(1,zoom));
    const overviewCap=78,textCap=Math.min(300,overviewCap+124*logZoom),growth=smoothLabel(logZoom/5);
    for(const [level,band] of result.bands.entries())for(const [index,entry] of band.entries()){
      const {item,anchor,iconLeft}=entry,previous=band[index-1],next=band[index+1];
      // Disjoint cells protect every icon. A label can borrow room to its left at
      // the viewport edge, but its contents always read icon, then title.
      const leftLimit=previous?(previous.iconLeft+iconWidth+iconLeft+gap)/2:0;
      const rightLimit=next?(iconLeft+iconWidth+next.iconLeft-gap)/2:result.reserve&&level===0?width-overflowWidth-gap:width;
      // Reveal within the existing icon-first cells, driven by the live camera.
      // Text, gap and corners share one reversible progress; glyphs never scale.
      const budget=Math.min(item.textWidth+gap,textCap,Math.max(0,rightLimit-leftLimit-iconWidth));
      // Start with a readable short title whenever its cell has room. Zoom
      // progressively reveals more; text still cannot displace another icon.
      const baseline=Math.min(overviewCap,budget),extra=baseline+(budget-baseline)*growth;
      const reveal=smoothLabel(extra/80),titleGap=gap*reveal;
      const textWidth=Math.max(0,extra-titleGap);
      const fadeSpan=Math.max(1,Math.min(64,item.textWidth*.8));
      const opacity=smoothLabel((extra-3)/fadeSpan),radius=iconWidth/2-6*reveal;
      const tagWidth=iconWidth+extra,left=Math.max(leftLimit,Math.min(iconLeft,rightLimit-tagWidth));
      item.level=level;item.button.hidden=false;item.link.style.display='';item.anchor.style.display='';
      entry.left=left;entry.width=tagWidth;
      entry.before=previous?JSON.stringify([previous.item.page.url,previous.session]):null;
      entry.after=next?JSON.stringify([next.item.page.url,next.session]):result.reserve&&level===0?'overflow-edge':null;
      item.button.style.setProperty('--tag-width',tagWidth+'px');item.button.style.setProperty('--title-width',textWidth+'px');item.button.style.setProperty('--title-gap',titleGap+'px');
      item.button.style.setProperty('--title-opacity',opacity);item.button.style.setProperty('--tag-radius',radius+'px');
      item.button.classList.toggle('icon-only',textWidth===0);
      item.button.dataset.labelMode=textWidth===0?'icon':textWidth+.5>=item.textWidth?'full':'short';
      item.anchor.setAttribute('cx',anchor);
    }
    // Every zoom level keeps the same compact single-line rows. Full text is
    // available on hover or focus without changing the timeline's layout.
    let highest=0;
    for(const [level,band] of result.bands.entries()){
      const below=splitLabels&&level%2===1;
      const row=splitLabels?Math.floor(level/2):level;
      const top=below?96+row*rowPitch:-firstRowTop-row*rowPitch;
      for(const {item,anchor,left,width:tagWidth,session,before,after} of band){
        highest=Math.min(highest,top);
        item.anchor.setAttribute('cy',below?'294':'252');
        placeTag(item,{left,top,width:tagWidth,plotWidth:width,anchor,session,below,before,after},animate);
      }
    }
    if(splitLabels){
      const lowerRows=Math.floor(Math.min(levels,pages.length)/2);
      $('#scene').style.setProperty('--lower-space',(lowerRows?12+lowerRows*rowPitch:0)+'px');
    }
    $('#canvas').style.setProperty('--tag-space',Math.max(0,24-highest)+'px');
    for(const item of result.hidden){item.button.hidden=true;item.link.style.display='none';item.anchor.style.display='none';}
    for(const item of tagMap.values())if(item.button.hidden){item.pose=null;item.button.style.removeProperty('translate');item.button.removeAttribute('data-reflow');}
    hiddenPages=result.hidden.map(item=>item.page);
    more.hidden=!result.hidden.length;more.textContent='+'+result.hidden.length;more.title=`查看其余 ${result.hidden.length} 个网页`;
    more.setAttribute('aria-label',`查看其余 ${result.hidden.length} 个网页`);more.style.top='-62px';more.style.right='0';
    pageHighlight?.refresh();
  }
  function positionBlock(block){
    const s=block.segment;
    block.style.left=timePosition(s.a)+'%';block.style.width=(timePosition(s.b)-timePosition(s.a))+'%';
    block.hidden=s.b<=camera.start||s.a>=camera.end;
    if(selected?.url===s.url&&selected.visitId===s.id){
      block.classList.add('visit-selected');
      block.parentNode.style.setProperty('--visit-x',timePosition((s.a+s.b)/2)+'%');
    }
  }
  function stopNavigation(){cancelAnimationFrame(camera.frame);camera.frame=0;camera.velocityStart=camera.velocityEnd=0;camera.lockAt=null;wheelZoomTarget=null;}
  function hourInstant(value) {
    const day = localDate(date);
    return day.setMinutes(value);
  }
  function hourWindow(instant) {
    const halfSpan = Math.min(3600000, camera.end - camera.start) / 2;
    return [instant - halfSpan, instant + halfSpan];
  }
  function hourMinute(instant) {
    if (instant === rangeEnd) return 1440;
    const local = new Date(instant);
    return local.getHours() * 60 + local.getMinutes();
  }
  function showHourMarker(instant) {
    const marker = $('#hour-marker');
    marker.hidden = instant == null || instant < camera.start || instant > camera.end;
    if (!marker.hidden) marker.style.left = timePosition(instant) + '%';
  }
  function isFullDay(start = camera.start, end = camera.end) {
    return start === rangeStart && end === rangeEnd;
  }
  function dialCenterMinute() {
    return isFullDay() ? 720 : hourMinute((camera.start + camera.end) / 2);
  }
  function resetHourDial(value = dialCenterMinute()) {
    scrubOrigin = null;
    lockedTime = null;
    $('#hour-dial').removeAttribute('data-locked');
    hourDial.reset(value);
    showHourMarker(null);
  }
  function clampWindow(start,end){
    const span=Math.min(rangeEnd-rangeStart,Math.max(MIN_SPAN,end-start));
    start=Math.max(rangeStart,Math.min(rangeEnd-span,start));return [start,start+span];
  }
  function navigationSound(previous){
    const span=camera.end-camera.start,step=[1,5,10,15,30,60].find(n=>n*60000>=span/60)*60000;
    const center=(camera.start+camera.end)/2,oldCenter=(previous[0]+previous[1])/2;
    if(Math.floor(center/step)!==Math.floor(oldCenter/step)||Math.floor(span/step)!==Math.floor((previous[1]-previous[0])/step))
      dial.tick({major:Math.floor(center/3600000)!==Math.floor(oldCenter/3600000)});
  }
  function moveCameraWindow(start,end,sound){
    dateMotion?.finish();
    const previous=[camera.start,camera.end],[a,b]=clampWindow(start,end);camera.start=a;camera.end=b;
    closeOverflow();
    if(sound)navigationSound(previous);
    if(!navigationPaint)navigationPaint=requestAnimationFrame(()=>{navigationPaint=0;paintNavigation();});
    return a !== previous[0] || b !== previous[1];
  }
  function updateCamera(start,end,sound=true,lockAt=null){
    const moved = moveCameraWindow(start,end,sound);
    if (moved || lockAt !== lockedTime) {
      lockedTime = lockAt;
      $('#hour-dial').toggleAttribute('data-locked', lockAt !== null);
      showHourMarker(lockAt);
      roomMinute = lockAt === null ? dialCenterMinute() : hourMinute(lockAt);
      hourDial.setMinute(roomMinute);
      room?.setMinute(roomMinute);
    }
  }
  function paintNavigation(animateTags=true){
    renderTicks();for(const row of laneMap.values())for(const b of row.blocks.values())positionBlock(b);layoutTags(animateTags);
    $('#tooltip').hidden=true;paintTimeProbe();
    if(returningTo&&!camera.frame){
      const {start,end,opener}=returningTo;
      returningTo=null;
      if(document.activeElement===$('#timeline-nav')&&Math.abs(camera.start-start)<1&&Math.abs(camera.end-end)<1&&opener?.isConnected&&!opener.hidden){
        opener.focus({preventScroll:true});
      }
    }
  }
  function animateCamera(start,end,velocity=0,{lockAt=null,wheel=false}={}){
    if(!wheel)wheelZoomTarget=null;
    camera.lockAt=lockAt;
    [camera.targetStart,camera.targetEnd]=clampWindow(start,end);
    if (isFullDay(camera.targetStart, camera.targetEnd)) {
      resetHourDial(720);
      roomMinute = 720;
      room?.setMinute(roomMinute);
    }
    // A running spring may be retargeted. Only the viewport moves during a return to noon.
    function applyFrame(a, b) {
      if (isFullDay(camera.targetStart, camera.targetEnd)) moveCameraWindow(a, b, true);
      else updateCamera(a, b, true, camera.lockAt);
    }
    if(reduced.matches || (camera.start===camera.targetStart && camera.end===camera.targetEnd)){
      applyFrame(camera.targetStart,camera.targetEnd);stopNavigation();return;
    }
    if(velocity)camera.velocityStart=camera.velocityEnd=velocity;
    if(camera.frame)return;camera.last=performance.now();
    const frame=now=>{
      const dt=Math.min(.04,(now-camera.last)/1000),omega=wheelZoomTarget?28:18,e=Math.exp(-omega*dt);camera.last=now;
      const next=[];
      for(const [value,target,velocityKey] of [['start','targetStart','velocityStart'],['end','targetEnd','velocityEnd']]){
        const delta=camera[value]-camera[target],c=camera[velocityKey]+omega*delta;
        next.push(camera[target]+(delta+c*dt)*e);camera[velocityKey]=(camera[velocityKey]-omega*c*dt)*e;
      }
      applyFrame(...next);
      if(Math.abs(camera.start-camera.targetStart)<5&&Math.abs(camera.end-camera.targetEnd)<5){
        applyFrame(camera.targetStart,camera.targetEnd);stopNavigation();
      }else camera.frame=requestAnimationFrame(frame);
    };camera.frame=requestAnimationFrame(frame);
  }
  function wheelUnit(event) {
    return event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
  }
  function wheelZoomFactor(event) {
    const change = event.deltaY * wheelUnit(event) * (event.ctrlKey ? .008 : .002);
    return Math.exp(Math.max(-.65, Math.min(.65, change)));
  }
  function zoomCamera(factor, {anchor = .5, animate = false, dialInstant = null, wheel = false} = {}) {
    const oldSpan = camera.end - camera.start;
    const daySpan = rangeEnd - rangeStart;
    const source = dialInstant === null ? 'axis' : 'dial';
    const continuing = wheel && camera.frame && wheelZoomTarget?.source === source;
    // Accumulate notches against the destination, while anchoring to the time
    // actually under the pointer. Reading the lagging span would lose input.
    const baseSpan = continuing ? wheelZoomTarget.span : oldSpan;
    const newSpan = Math.max(MIN_SPAN, Math.min(daySpan, baseSpan * factor));
    const instant = dialInstant ?? (camera.start + anchor * oldSpan);
    const start = instant - anchor * newSpan;
    if (wheel) {
      if (!continuing) stopNavigation();
      const spanVelocity = camera.velocityEnd - camera.velocityStart;
      // Keep the anchor stationary even when the pointer moves mid-gesture.
      camera.velocityStart = -anchor * spanVelocity;
      camera.velocityEnd = (1 - anchor) * spanVelocity;
      wheelZoomTarget = {span: newSpan, source};
      animateCamera(start, start + newSpan, 0, {lockAt: newSpan < daySpan ? dialInstant : null,wheel:true});
    } else if (animate) {
      animateCamera(start, start + newSpan);
    } else {
      stopNavigation();
      updateCamera(start, start + newSpan, true, newSpan < daySpan ? dialInstant : null);
    }
  }
  function resetCamera(){animateCamera(rangeStart,rangeEnd);}
  function showTagTooltip(event,page){
    const box=$('#tooltip');box.replaceChildren(el('strong','',page.title||page.host),el('span','',`首次 ${time(page.items[0].a)} · 合计 ${duration(sumUnion(page.items))}`));box.hidden=false;moveTooltip(event);
  }
  function paintSticky(){const stuck=!splitLabels&&$('#scene').getBoundingClientRect().top<42;$('#axis').classList.toggle('stuck',stuck);$('#axis').style.setProperty('--axis-surface',stuck?1:0);}
  function runSpring(state,paint){
    if(reduced.matches){cancelAnimationFrame(state.frame);state.frame=0;state.p=state.target;state.v=0;paint();return;}
    if(state.frame)return;state.last=performance.now();
    const frame=now=>{const dt=Math.min(.04,(now-state.last)/1000);state.last=now;const omega=18,delta=state.p-state.target,c=state.v+omega*delta,e=Math.exp(-omega*dt);
      state.p=state.target+(delta+c*dt)*e;state.v=(state.v-omega*c*dt)*e;
      if(state.p<0||state.p>1){state.p=Math.max(0,Math.min(1,state.p));state.v=0;}paint();
      if(Math.abs(state.p-state.target)<.0005&&Math.abs(state.v)<.004){state.p=state.target;state.v=0;state.frame=0;paint();}
      else state.frame=requestAnimationFrame(frame);
    };state.frame=requestAnimationFrame(frame);
  }
  function closeOverflow(restoreFocus=false){
    const list=$('#overflow-list'),active=list.contains(document.activeElement);
    list.hidden=true;$('#more-pages').setAttribute('aria-expanded','false');
    if((restoreFocus||active)&&!$('#more-pages').hidden)$('#more-pages').focus({preventScroll:true});
  }
  function positionOverflow(){
    const list=$('#overflow-list'),anchor=$('#more-pages').getBoundingClientRect(),margin=12;
    const width=Math.min(420,innerWidth-margin*2),above=Math.max(0,anchor.top-margin-8),below=Math.max(0,innerHeight-anchor.bottom-margin-8);
    const openAbove=above>below,maxHeight=Math.min(356,Math.max(above,below));
    list.style.width=width+'px';list.style.maxHeight=maxHeight+'px';
    list.style.left=Math.max(margin,Math.min(innerWidth-width-margin,anchor.right-width))+'px';
    list.style.top=(openAbove?Math.max(margin,anchor.top-8-list.offsetHeight):anchor.bottom+8)+'px';
  }
  function showOverflow(){
    dateMotion?.finish();
    const list=$('#overflow-list');if(!list.hidden){closeOverflow(true);return;}if(!hiddenPages.length)return;
    dateControl?.close();
    stopNavigation();hideTimeProbe();$('#tooltip').hidden=true;list.replaceChildren();
    const first=p=>Math.max(camera.start,p.items.find(s=>s.b>camera.start&&s.a<camera.end).a);
    for(const page of [...hiddenPages].sort((a,b)=>first(a)-first(b)||a.url.localeCompare(b.url))){
      const button=el('button','overflow-item'),title=page.title||page.host;
      button.dataset.url=page.url;button.dataset.site=page.domain;button.style.setProperty('--tone',page.color);button.title=title;
      const at=first(page);button.append(siteIcon(page.host,page.url),el('span','overflow-title',title),el('time','overflow-time',time(at)));
      button.setAttribute('aria-label',`${title}，${time(at)}，查看详情`);
      button.onclick=()=>{activatePage(page);if(selected)lastFocus=$('#more-pages');};list.append(button);
    }
    list.hidden=false;list.scrollTop=0;$('#more-pages').setAttribute('aria-expanded','true');positionOverflow();pageHighlight?.refresh();list.querySelector('button')?.focus({preventScroll:true});
  }
  function resetNavigation(){closeOverflow();stopNavigation();resetHourDial();}
  function setDate(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(+localDate(value))||key(localDate(value))!==value)return;
    dateControl?.close();pageHighlight?.clear();
    const apply=()=>{resetNavigation();date=value;closeDetail();render();if($('#date-input'))updateDateControls();};
    if(dateMotion)dateMotion.change({fromDate:date,toDate:value},apply);else apply();
  }
  function renderStatus(){
    const names={paused:'记录已暂停',recording:'正在记录',idle:'空闲中',locked:'电脑已锁定',unfocused:'浏览器未聚焦',unsupported:'等待网页活动',error:'记录器异常','storage-full':'存储空间已满'};
    const action=isExtension?(liveRecorder.recording?'暂停记录':'开始记录'):'连接记录器';
    const hint=isExtension?`${action}；当前：${names[liveRecorder.status]||'等待网页活动'}`:'安装本地浏览器记录器';
    const problem=['error','storage-full'].includes(liveRecorder.status);
    if($('#record-button')){$('#record-button').textContent=problem?names[liveRecorder.status]:action;$('#record-button').setAttribute('aria-label',hint);$('#record-button').title=hint;}
    $('#empty-start').hidden=filtered.length > 0 || mode !== 'live' || liveRecorder.recording;
  }
  function activatePage(page){
    const samePage=selected?.url===page.url&&pageHighlight.snapshot().site===page.domain;
    closeOverflow();
    if(samePage){closeDetail();return;}
    openDetail({url:page.url,host:page.host});
  }
  function clearVisit(){
    if(!selected)return;
    laneMap.get(selected.url)?.blocks.get(selected.visitId)?.classList.remove('visit-selected');
    delete selected.visitId;
  }
  function rememberOriginalView(){
    if(originalView)return;
    originalView={start:camera.start,end:camera.end,scrollTop:window.scrollY,opener:lastFocus};
    $('#return-original-view').hidden=false;
  }
  function clearOriginalView(){
    originalView=null;returningTo=null;
    $('#return-original-view').hidden=true;
  }
  function returnToOriginalView(){
    if(!originalView)return;
    const origin=originalView;
    closeDetail();
    $('#timeline-nav').focus({preventScroll:true});
    stopNavigation();returningTo=origin;
    animateCamera(origin.start,origin.end);
    if(window.scrollY!==origin.scrollTop)window.scrollTo({top:origin.scrollTop,behavior:reduced.matches?'instant':'smooth'});
  }
  function openDetail(value){
    dateMotion?.finish();dateControl?.close();clearVisit();clearOriginalView();
    lastFocus=document.activeElement;selected=value;pageHighlight.select(siteMeta(value.host).domain);
    const panel=$('#inspector');panel.classList.remove('align-left');panel.inert=false;
    renderInspector();panel.scrollTop=0;detail.target=1;runSpring(detail,paintDetail);
    $('#tooltip').hidden=true;$('#close-inspector').focus({preventScroll:true});
  }
  function closeDetail(){
    clearVisit();clearOriginalView();pageHighlight?.clear();selected=null;detail.target=0;$('#inspector').inert=true;
    runSpring(detail,paintDetail);
    if(lastFocus){const target=lastFocus.isConnected&&!lastFocus.hidden?lastFocus:$('#timeline-nav');target.focus({preventScroll:true});}
    lastFocus=null;
  }
  function paintDetail(){const p=detail.p;$('#inspector').style.opacity=p;$('#inspector').style.transform=`translateY(${(1-p)*15}px)`;}
  function locateVisit(id,url=selected?.url,direction){
    const block=laneMap.get(url)?.blocks.get(id);
    if(!block)return;
    rememberOriginalView();
    const s=block.segment,center=(s.a+s.b)/2,span=Math.max(MIN_SPAN,(s.b-s.a)*1.4);
    const [start,end]=clampWindow(center-span/2,center+span/2);
    clearVisit();
    if(selected.url!==s.url){
      selected={url:s.url,host:s.host};
      pageHighlight.select(siteMeta(s.host).domain);
    }
    selected.visitId=id;positionBlock(block);
    const plot=$('#lanes').getBoundingClientRect(),panel=$('#inspector');
    const x=plot.left+(center-start)/(end-start)*plot.width;
    panel.classList.toggle('align-left',x>innerWidth/2&&x>innerWidth-panel.offsetWidth-64);
    renderInspector(id,direction);stopNavigation();animateCamera(start,end);
    if(plot.top<0||plot.top+BAR_HEIGHT>innerHeight){
      const offset=plot.top+BAR_HEIGHT/2-innerHeight*.55;
      window.scrollBy({top:offset,behavior:reduced.matches?'instant':'smooth'});
    }
  }
  const REVISIT_GAP_MS=5*60_000;
  function neighboringVisits(visit){
    let previous=null,containsVisit=false,coveredUntil=0;
    for(let index=0;index<filtered.length;index++){
      const item=filtered[index],last=filtered[index-1];
      if(!last||item.url!==last.url||item.a-coveredUntil>=REVISIT_GAP_MS){
        if(containsVisit)return {previous,next:item};
        previous=last;
        coveredUntil=item.b;
      }else{
        // A shorter overlapping visit can end before another part of the same run.
        coveredUntil=Math.max(coveredUntil,item.b);
      }
      if(item===visit)containsVisit=true;
    }
    return {previous,next:null};
  }
  function visitContext(s){
    const {previous,next}=neighboringVisits(s);
    if(!previous&&!next)return document.createDocumentFragment();
    const context=el('nav','visit-context');
    context.setAttribute('aria-label','按浏览顺序切换网页');
    for(const [direction,label,neighbor] of [['previous','上一页',previous],['next','下一页',next]]){
      if(!neighbor)continue;
      const line=el('button','visit-neighbor'),title=neighbor.title||neighbor.host;
      line.type='button';
      line.dataset.direction=direction;line.dataset.session=neighbor.id;
      line.setAttribute('aria-controls','scene inspector-content');
      const name=el('span','visit-neighbor-title',title);name.title=title;
      const at=el('time','',visitTime(neighbor.a));at.dateTime=new Date(neighbor.a).toISOString();
      const heading=el('span','visit-direction'),arrow=icon(direction==='previous'?'back':'next');
      arrow.setAttribute('aria-hidden','true');heading.append(arrow,label);
      line.append(heading,siteIcon(neighbor.host,neighbor.url),name,at);
      line.onclick=()=>locateVisit(neighbor.id,neighbor.url,direction);
      context.append(line);
    }
    return context;
  }
  function renderInspector(focusVisit,neighborDirection){
    if(!selected)return;
    const items=laneMap.get(selected.url)?.page.items||[],content=$('#inspector-content');
    if(!items.length){closeDetail();content.replaceChildren();return;}
    if(selected.visitId!=null&&!items.some(s=>s.id===selected.visitId))clearVisit();
    const active=document.activeElement;
    const direction=neighborDirection??(focusVisit==null?active.closest('.visit-neighbor')?.dataset.direction:null);
    const focusId=focusVisit??active.closest('.detail-session')?.dataset.session??(direction?selected.visitId:null);
    const restoreLink=active.classList.contains('detail-url'),body=document.createDocumentFragment();
    const current=items.find(s=>s.id===selected.visitId),title=current?.title||items[0]?.title||selected.host;
    $('#detail-site').textContent=siteMeta(selected.host).name;
    const url=new URL(selected.url),link=el('a','detail-url',url.hostname+url.pathname);
    link.href=selected.url;link.target='_blank';link.rel='noopener noreferrer';link.append(icon('link'));
    const total=duration(sumUnion(items)),metric=el('div','detail-metric',total);
    metric.setAttribute('aria-label','当天前台活动 '+total);
    body.append(el('h2','detail-title',title),link,metric,el('h3','detail-heading','活动时间'));
    let focusRow;
    for(const s of items){
      const row=el('button','detail-session'),label=spanTime(s.a,s.b),at=el('time','',duration(s.b-s.a));
      row.type='button';row.dataset.session=s.id;row.setAttribute('aria-controls','scene');
      row.setAttribute('aria-label','定位到 '+label+'，'+at.textContent);
      row.setAttribute('aria-pressed',String(s===current));
      row.append(el('span','visit-time',label),at,icon('next'));
      row.onclick=()=>locateVisit(s.id);body.append(row);
      if(s.id===focusId)focusRow=row;
      if(s===current&&filtered.length>1)body.append(visitContext(s));
    }
    content.replaceChildren(body);
    const focusTarget=(direction&&content.querySelector('button.visit-neighbor[data-direction="'+direction+'"]'))||focusRow;
    if(focusTarget)focusTarget.focus({preventScroll:true});else if(restoreLink)link.focus({preventScroll:true});
    if(focusVisit!=null&&focusRow){
      const panel=$('#inspector'),rowTop=focusRow.getBoundingClientRect().top;
      const context=focusRow.nextElementSibling?.matches('.visit-context')?focusRow.nextElementSibling:focusRow;
      const bounds=panel.getBoundingClientRect();
      const visibleTop=Math.max(bounds.top+12,panel.querySelector('header').getBoundingClientRect().bottom+6);
      const overflow=context.getBoundingClientRect().bottom-bounds.bottom+12;
      if(rowTop<visibleTop)panel.scrollTop-=visibleTop-rowTop;
      else if(overflow>0)panel.scrollTop+=Math.min(overflow,rowTop-visibleTop);
    }
  }
  function moveTooltip(event){const box=$('#tooltip');box.style.left=Math.max(12,Math.min(innerWidth-box.offsetWidth-14,event.clientX+14))+'px';box.style.top=Math.max(12,Math.min(innerHeight-box.offsetHeight-14,event.clientY-box.offsetHeight-16))+'px';}
  let toastTimer;function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
  function dialog(title){$('#dialog-title').textContent=title;$('#dialog-content').replaceChildren();if(!$('#settings-dialog').open)$('#settings-dialog').showModal();return $('#dialog-content');}
  function settingsRow(c,title,caption,label,fn,id,danger=false){const row=el('div','setting-row'),text=el('div');text.append(el('strong','',title));if(caption)text.append(el('small','',caption));const b=el('button','button'+(danger?' danger':''),label);if(id)b.id=id;b.onclick=fn;row.append(text,b);c.append(row);return b;}
  function updateDateControls(){if(!$('#date-input'))return;$('#date-input').value=date;$('#next-day').disabled=date>=today();$('#dialog-title').textContent=localDate(date).toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'});}
  function showSettings(){
    if(dateControl?.isOpen())dateControl.close(true);
    pageHighlight?.clear();
    $('#tooltip').hidden=true;const c=dialog('设置'),controls=el('div','date-control');
    const prev=el('button','icon-button'),next=el('button','icon-button'),input=el('input');prev.id='prev-day';next.id='next-day';input.id='date-input';input.type='date';input.max=today();input.setAttribute('aria-label','选择日期');prev.setAttribute('aria-label','前一天');next.setAttribute('aria-label','后一天');prev.append(icon('back'));next.append(icon('next'));prev.onclick=()=>setDate(shift(date,-1));next.onclick=()=>setDate(shift(date,1));input.onchange=e=>setDate(e.target.value);controls.append(prev,input,next);c.append(controls);
    settingsRow(c,'网页记录','仅在本机保存','开始记录',toggleRecording,'record-button');
    const soundButton=settingsRow(c,'刻度音效','','',()=>{dial.setEnabled(!dial.enabled);if(dial.enabled)dial.unlock();syncSound();},'sound-button');
    function syncSound(){soundButton.textContent=dial.enabled?'开启':'静音';soundButton.setAttribute('aria-pressed',dial.enabled);}syncSound();
    settingsRow(c,'导出','包含所有日期的记录','导出 JSON',exportData,'export-button');
    settingsRow(c,'导入','只在当前页面查看','选择文件',()=>$('#import-input').click(),'import-button');
    if(isExtension&&mode!=='live')settingsRow(c,'本机记录','','返回',async()=>{mode='live';await refresh(true);$('#settings-dialog').close();},'return-live');
    settingsRow(c,'计时方式','','了解',showInfo,'measurement-info');
    if(isExtension)settingsRow(c,'清空记录','同时暂停采集','清空',confirmClear,'clear-data',true);
    else settingsRow(c,'示例数据','','恢复示例',()=>{resetNavigation();mode='demo';data=validate(window.TRACE_DEMO);date=latestDate(data);closeDetail();render();$('#settings-dialog').close();},'restore-demo');
    updateDateControls();renderStatus();
  }
  function showInfo(){const c=dialog('关于计时');
    if(data.source==='activitywatch-foreground'){
      c.append(el('p','dialog-copy','来自本机 ActivityWatch。网页记录与 Edge 前台窗口、非空闲区间取交集后显示；未被采集的时间保持空白。'),el('p','dialog-copy','这份记录反映采集器覆盖到的前台活动，不代表完整浏览历史，也不代表阅读、专注或学习时长。'),el('p','modal-note','本地导入文件；不上传网址、标题或活动记录。'));return;
    }
    c.append(el('p','dialog-copy','色块表示浏览器前台活动的估计区间。网页切换、窗口失去焦点或系统空闲会结束一段；未记录的时间保持空白。'),el('p','dialog-copy','系统空闲阈值为 60 秒，每约 30 秒保存一次。短暂离开、浏览器休眠或异常关闭可能造成误差；这些时间不代表阅读、专注或学习时长。'),el('p','modal-note','只记录网址、标题与活动时间。不会读取网页正文、Cookie、密码或历史记录，也不会上传数据。'));
  }
  function showSetup(){const c=dialog('连接记录器');c.append(el('p','dialog-copy','普通网页无法记录其他标签页。安装配套扩展后，即可在本机开始记录。'));const steps=el('ol','setup-steps');for(const text of ['打开 Edge 扩展管理，开启开发人员模式。','选择“加载解压缩的扩展”，选择 extension 文件夹。','点击工具栏的 PageAgo，在设置中开始记录。'])steps.append(el('li','',text));c.append(steps,el('p','setup-path','prototypes / trace-next / extension'),el('p','modal-note','Chrome 同样支持。安装默认暂停；无痕窗口不采集。'));}
  function confirmClear(){const c=dialog('清空全部记录？');c.append(el('p','dialog-copy','这会删除此 PageAgo 扩展中的全部记录并暂停采集。建议先导出备份。'));const actions=el('div','dialog-actions'),cancel=el('button','button','取消'),clear=el('button','button danger','确认清空');cancel.onclick=showSettings;clear.onclick=async()=>{clear.disabled=true;try{await send({type:'trace:clear-data'});const clearedColors=siteColors('live').clear();preparedColorData=null;mode='live';await refresh(true);$('#settings-dialog').close();toast(clearedColors?'记录已清空，采集已暂停。':'记录已清空，采集已暂停，但浏览器未能移除配色缓存。');}catch(e){clear.disabled=false;toast(e.message);}};actions.append(cancel,clear);c.append(actions);}
  function exportData(){const payload={schema:'trace.v1',exportedAt:new Date().toISOString(),source:isDemo()?'synthetic-demo':mode==='live'?'trace-recorder':data.source||'imported',sessions:data.sessions};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),link=el('a');link.href=URL.createObjectURL(blob);link.download=`pageago-${date}${isDemo()?'-demo':''}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);toast('已导出全部记录。');}
  async function send(message){const result=await chrome.runtime.sendMessage(message);if(result?.error&&message.type!=='trace:get')throw Error(result.error);return result;}
  let refreshing=false;async function refresh(force=false){
    if(!isExtension||refreshing)return;refreshing=true;
    try{const result=validate(await send({type:'trace:get'}));liveRecorder={recording:!!result.recording,status:result.status};const signature=JSON.stringify(result);
      if(mode==='live'&&(force||signature!==lastLiveSignature)){data=result;if(force||!date){resetNavigation();if(selected)closeDetail();date=today();}render();lastLiveSignature=signature;}else renderStatus();
    }catch(e){liveRecorder.status='error';renderStatus();toast('无法读取本机记录：'+e.message);}finally{refreshing=false;}
  }
  async function toggleRecording(){if(!isExtension){showSetup();return;}try{const current=await send({type:'trace:get'}),result=await send({type:'trace:set-recording',enabled:!current.recording});liveRecorder={recording:!!result.recording,status:result.status};if(result.status==='storage-full'){renderStatus();toast('存储已满，请先导出记录。');return;}const switching=mode!=='live';mode='live';await refresh(switching);toast(liveRecorder.recording?'记录已开启。':'记录已暂停。');}catch(e){toast(e.message);}}
  function wire(){
    $('#return-original-view').onclick=returnToOriginalView;
    const toggle=$('#timeline-nav');let drag=null;
    toggle.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;probePoint={x:e.clientX,y:e.clientY};paintTimeProbe();});
    toggle.addEventListener('pointerleave',hideTimeProbe);
    toggle.onpointerdown=e=>{
      if(e.button!==0||!filtered.length)return;dial.unlock();stopNavigation();
      dateControl?.close();
      closeOverflow();drag={id:e.pointerId,x:e.clientX,y:e.clientY,start:camera.start,end:camera.end,last:performance.now(),moved:false,direction:null,samples:[]};
      toggle.setPointerCapture(e.pointerId);
    };
    toggle.onpointermove=e=>{
      if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y,now=performance.now();
      if(!drag.direction){if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;drag.direction=Math.abs(dx)>Math.abs(dy)?'pan':'vertical';drag.moved=true;$('#scene').classList.add('dragging');}
      if(drag.direction==='pan'){
        const delta=-dx/$('#lanes').clientWidth*(drag.end-drag.start);updateCamera(drag.start+delta,drag.end+delta);
        drag.samples.push({at:now,position:camera.start});drag.samples=drag.samples.filter(s=>now-s.at<90);
      }
      drag.last=now;
    };
    toggle.onpointerup=()=>{
      if(!drag)return;$('#scene').classList.remove('dragging');
      if(drag.moved){
        if(drag.direction==='pan'){
          const first=drag.samples[0],last=drag.samples.at(-1),elapsed=last&&first?(last.at-first.at)/1000:0;
          const velocity=performance.now()-drag.last<100&&elapsed>.01?(last.position-first.position)/elapsed:0;
          const limit=(camera.end-camera.start)*2,release=Math.max(-limit,Math.min(limit,velocity));
          if(Math.abs(release)>1000)animateCamera(camera.start+release*.15,camera.end+release*.15,release);
        }
      }
      if(!drag.moved)closeDetail();
      drag=null;
    };
    toggle.onpointercancel=()=>{drag=null;$('#scene').classList.remove('dragging');};
    toggle.addEventListener('wheel',e=>{
      e.preventDefault();if(!filtered.length)return;if(navigator.userActivation?.hasBeenActive)dial.unlock();
      if(!e.ctrlKey&&(e.shiftKey||Math.abs(e.deltaX)>Math.abs(e.deltaY))){
        stopNavigation();
        const pixels=(e.shiftKey&&Math.abs(e.deltaY)>Math.abs(e.deltaX)?e.deltaY:e.deltaX)*wheelUnit(e),delta=pixels/$('#lanes').clientWidth*(camera.end-camera.start);updateCamera(camera.start+delta,camera.end+delta);
      }else{
        const rect=$('#lanes').getBoundingClientRect(),anchor=Math.max(0,Math.min(1,(e.clientX-rect.x)/rect.width));
        zoomCamera(wheelZoomFactor(e), {anchor,wheel:true});
      }
    },{passive:false});
    toggle.onkeydown=e=>{
      if(e.ctrlKey||e.metaKey||e.altKey||!filtered.length)return;
      if(!['+','=','-','_','Home','ArrowLeft','ArrowRight'].includes(e.key))return;
      e.preventDefault();e.stopPropagation();dial.unlock();
      if(e.key==='Home')resetCamera();else if(['+','=','-','_'].includes(e.key))zoomCamera(['+','='].includes(e.key)?1/1.6:1.6,{animate:true});
      else{stopNavigation();const delta=(camera.end-camera.start)*.1*(e.key==='ArrowLeft'?-1:1);animateCamera(camera.start+delta,camera.end+delta);}
    };
    $('#zoom-in').onclick=()=>{dial.unlock();zoomCamera(1/1.6,{animate:true});};
    $('#zoom-out').onclick=()=>{dial.unlock();zoomCamera(1.6,{animate:true});};
    $('#zoom-reset').onclick=()=>{dial.unlock();resetCamera();};
    $('#hour-dial-reset').onclick=event=>{
      const arrow = event.currentTarget.querySelector('svg');
      if (!reduced.matches && !arrow.getAnimations().length) {
        arrow.animate([{transform:'rotate(0deg)'},{transform:'rotate(-360deg)'}],
          {duration:440, easing:'cubic-bezier(.3, 0, .2, 1)'});
      }
      dial.unlock();resetCamera();
    };
    $('#more-pages').onclick=showOverflow;
    $('#overflow-list').onkeydown=e=>{
      if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();
      const items=[...$('#overflow-list').querySelectorAll('button')],index=items.indexOf(document.activeElement);
      const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[next]?.focus();
    };
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('#overflow-list,#more-pages'))closeOverflow();});
    document.addEventListener('focusin',e=>{if(!e.target.closest('#overflow-list,#more-pages'))closeOverflow();});
    document.addEventListener('click',e=>{if(!e.target.closest('button,a,input,select,textarea,#timeline-nav,#hour-dial,#inspector,#date-control,dialog,#overflow-list'))closeDetail();});
    $('#settings-button').onclick=showSettings;$('#close-dialog').onclick=()=>$('#settings-dialog').close();$('#close-inspector').onclick=closeDetail;$('#empty-start').onclick=toggleRecording;
    $('#import-input').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>20*1024*1024)throw Error('文件不能超过 20 MB。');const next=validate(JSON.parse(await file.text()));resetNavigation();data=next;mode='import';date=latestDate(next);closeDetail();$('#settings-dialog').close();render();toast(`已打开 ${next.sessions.length} 段记录。`);}catch(error){toast('无法打开：'+error.message);}finally{e.target.value='';}};
    document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key==='Escape'){if(selected)closeDetail();else if(!$('#overflow-list').hidden)closeOverflow(true);$('#tooltip').hidden=true;}if(e.target.closest('input,button,a,#timeline-nav,#overflow-list')||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key==='ArrowLeft'){e.preventDefault();setDate(shift(date,-1));}if(e.key==='ArrowRight'&&date<today()){e.preventDefault();setDate(shift(date,1));}});
    addEventListener('scroll',()=>{paintSticky();if(!$('#overflow-list').hidden)positionOverflow();},{passive:true});addEventListener('resize',()=>{closeOverflow();paintNavigation(false);paintSticky();});addEventListener('blur',()=>{tagMotionPaused=true;finishTagMotion();});addEventListener('focus',()=>{tagMotionPaused=false;});reduced.addEventListener('change',()=>{if(reduced.matches){finishTagMotion();runSpring(detail,paintDetail);if(camera.frame){const a=camera.targetStart,b=camera.targetEnd,lockAt=camera.lockAt;stopNavigation();updateCamera(a,b,false,lockAt);}}});
    document.addEventListener('visibilitychange',()=>{
      if (!document.hidden) { refresh(); return; }
      if (camera.frame && isFullDay(camera.targetStart, camera.targetEnd)) {
        moveCameraWindow(rangeStart, rangeEnd, false);
      }
      stopNavigation();finishTagMotion();dateControl?.close();closeOverflow();drag=null;hideTimeProbe();$('#scene').classList.remove('dragging');
    });setInterval(()=>{if(!document.hidden)refresh();},30000);
  }
  window.traceSnapshot=()=>({ready:!!date,mode,date,range:[...view],viewport:[camera.start,camera.end],bounds:[rangeStart,rangeEnd],zoom:(rangeEnd-rangeStart)/(camera.end-camera.start),segments:filtered.length,pages:pages.length,sites:new Set(filtered.map(s=>s.host)).size,activeMs:sumUnion(filtered),recording:liveRecorder.recording,status:liveRecorder.status,drawer:detail.p,allSessions:data.sessions.length,overflowPages:hiddenPages.length,overflowOpen:!$('#overflow-list').hidden,dateCapsule:dateControl?.snapshot(),dateMotion:dateMotion?.snapshot()});
  dateMotion=TraceDateTimelineMotion.create({scene:$('#scene'),parts:[$('#constellation'),$('#lanes')],reduced});
  pageHighlight=TracePageHighlight.create({scene:$('#scene')});
  dateControl=TraceDateControl.create({root:$('#date-control'),today,onChange:setDate,onOpen:()=>{dateMotion?.finish();closeOverflow();closeDetail();pageHighlight.clear();hideTimeProbe();$('#tooltip').hidden=true;}});
  daySearch=TraceDaySearch.create({
    getPages:()=>pages,
    siteIcon,
    formatTime:time,
    locate(page,session){
      openDetail({url:page.url,host:page.host});
      lastFocus=$('#day-search-open');
      locateVisit(session.id);
    }
  });
  wire();date=today();if(isExtension){render();refresh(true);}else{data=validate(window.TRACE_LOCAL_DATA||window.TRACE_DEMO);mode=window.TRACE_LOCAL_DATA?'import':'demo';date=latestDate(data);render();}
})();
