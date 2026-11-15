/* An original, browser-local prototype. No ActivityWatch code or private data is bundled. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const HOUR = 3600000, DAY = 24 * HOUR;
  const icons = JSON.parse($('site-icons').textContent);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const symbol = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const palette = {
    'arxiv.org': ['#aa6456','#e5b7a8','#bb806c','#704237'],
    'github.com': ['#65789f','#c0cfe6','#91a5c4','#405578'],
    'huggingface.co': ['#a68b3a','#e9d38e','#c5af68','#756226'],
    'chatgpt.com': ['#658979','#bed5c5','#96b49e','#426b55'],
    'bing.com': ['#5d8d9e','#bcdce5','#91b8c5','#426f80'],
    'bilibili.com': ['#7395b4','#c2dbee','#98b9d0','#476e8d'],
    'youtube.com': ['#b26a6c','#e8b8bb','#c88e94','#804d50'],
    'zhihu.com': ['#6a86b5','#c0d3ee','#9aafd2','#486c9d'],
    'feishu.cn': ['#8a7eaa','#d5cbe5','#b3a6ca','#65577f'],
  };
  const state = {data:null, date:'', view:'site', sort:'duration', expanded:new Set(['arxiv.org']), zoom:1, plot:1000, pages:[], groups:[], bars:new Map(), selected:null, returnFocus:null};
  let toastTimer, resizeFrame;

  function color(domain) {
    const [accent,fill,stroke,text] = palette[domain] || ['#798d88','#dbe4de','#afbeb6','#4c6860'];
    return {accent,fill,stroke,text,style:`--accent:${accent};--fill:${fill};--stroke:${stroke};--text:${text};--halo:${accent}25`};
  }
  function canonicalDomain(url) {
    const host = new URL(url).hostname.toLowerCase();
    return Object.keys(icons).sort((a,b)=>b.length-a.length).find(d=>host===d || host.endsWith('.'+d)) || host.replace(/^www\./,'');
  }
  const siteName = domain => icons[domain]?.name || domain;
  function avatar(domain) {
    const icon = icons[domain]?.data_url;
    return `<span class="avatar" style="--accent:${color(domain).accent}" aria-hidden="true">${icon?.startsWith('data:image/') ? `<img src="${escape(icon)}" alt="">` : escape(siteName(domain).slice(0,1).toUpperCase())}</span>`;
  }
  const highlight = escape;
  function parseOffset(value) {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(value || '');
    if (!match || Number(match[2])>14 || Number(match[3])>59 || (Number(match[2])===14 && Number(match[3])!==0)) throw Error('utc_offset 必须是有效的时区偏移，例如 +08:00。');
    return (match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]))*60000;
  }
  function browserOffset() {
    const minutes = -new Date().getTimezoneOffset();
    return `${minutes<0?'-':'+'}${String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')}:${String(Math.abs(minutes)%60).padStart(2,'0')}`;
  }
  function validDate(date) {
    return typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(Date.parse(date)).toISOString().slice(0,10)===date;
  }
  function localDate(time, offset=state.data.offset) {return new Date(time+offset).toISOString().slice(0,10);}
  function clock(time, seconds=false) {
    if (time===windowBounds().end && !seconds) return '24:00';
    return new Date(time+state.data.offset).toISOString().slice(11,seconds?19:16);
  }
  function duration(ms, compact=true) {
    const seconds=Math.max(0,Math.round(ms/1000));
    if (seconds<60) return compact?`${seconds}s`:`${seconds} 秒`;
    const minutes=Math.floor(seconds/60),h=Math.floor(minutes/60),m=minutes%60;
    if (compact) return h?`${h}h${m?' '+m+'m':''}`:`${minutes}m`;
    return h?`${h} 小时${m?' '+m+' 分钟':''}`:`${minutes} 分钟${seconds%60?' '+seconds%60+' 秒':''}`;
  }
  function windowBounds() {
    const midnight=Date.parse(state.date+'T00:00:00'+state.data.utc_offset);
    return {start:midnight+6*HOUR,end:midnight+DAY};
  }
  function union(intervals) {
    const result=[];
    for (const range of [...intervals].sort((a,b)=>a.from-b.from || a.to-b.to)) {
      const previous=result.at(-1);
      if (previous && range.from<=previous.to) previous.to=Math.max(previous.to,range.to);
      else result.push({from:range.from,to:range.to});
    }
    return result;
  }
  const isVisits = () => state.data?.basis==='visit_events';
  const metric = owner => isVisits()?`${owner.sessions.length} 次`:duration(owner.duration);
  const total = intervals => union(intervals).reduce((sum,s)=>sum+s.to-s.from,0);

  function normalize(input) {
    if (!input || typeof input!=='object') throw Error('请选择有效的活动记录 JSON。');
    let rows,source,basis,offset,description,requestedDate;
    const notices={zero:0,unsupported:0};
    if (['daytrace.activity.v1','daytrace.visits.v1'].includes(input.schema) && Array.isArray(input.sessions)) {
      rows=input.sessions; source=input.source==='synthetic'?'synthetic':'import';
      basis=input.schema==='daytrace.visits.v1'?'visit_events':input.time_basis==='raw_browser_events'?'raw_browser_events':'declared_intervals';
      if (source==='synthetic' && basis!=='visit_events') basis='foreground_intervals';
      offset=input.utc_offset;description=String(input.description || '');requestedDate=input.date;
    } else {
      let buckets=input.buckets ?? input;
      if (buckets.type && Array.isArray(buckets.events)) buckets=[buckets];
      else if (!Array.isArray(buckets)) buckets=Object.entries(buckets).map(([id,b])=>b && typeof b==='object'?{...b,id:b.id || id}:null).filter(Boolean);
      const web=buckets.filter(b=>b.type==='web.tab.current' && Array.isArray(b.events));
      if (!web.length) throw Error('这份文件没有网页活动区间。请导入 ActivityWatch 的浏览器数据，或 daytrace.activity.v1 JSON；仅有访问时间的历史记录不能推算停留时长。');
      rows=[];source='activitywatch';basis='raw_browser_events';offset=browserOffset();
      description='ActivityWatch 浏览器原始事件。显示的是记录区间，未与桌面前台和空闲状态求交。';
      for (const bucket of web) {
        for (const [i,event] of bucket.events.entries()) {
          if (!Number.isFinite(event.duration) || event.duration<0) throw Error('ActivityWatch 事件的 duration 必须是非负秒数。');
          if (event.duration===0) {notices.zero++;continue;}
          const start=Date.parse(event.timestamp);
          if (!Number.isFinite(start)) throw Error('ActivityWatch 事件含有无效时间。');
          rows.push({id:`${bucket.id || 'web'}:${event.id ?? i}`,start:new Date(start).toISOString(),end:new Date(start+event.duration*1000).toISOString(),title:event.data?.title,url:event.data?.url,profile:String(bucket.id || 'ActivityWatch')});
        }
      }
    }
    const offsetMs=parseOffset(offset);
    if (rows.length>100000) throw Error('单次原型最多载入 100,000 个活动区间。');
    const sessions=[];
    for (const [i,row] of rows.entries()) {
      if (typeof row.start!=='string' || typeof row.end!=='string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(row.start) || !/(Z|[+-]\d{2}:\d{2})$/i.test(row.end)) throw Error(`第 ${i+1} 段需要包含时区的 start 和 end。`);
      const start=Date.parse(row.start),end=Date.parse(row.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end<start) throw Error(`第 ${i+1} 段的起止时间无效。`);
      if (basis==='visit_events' && end!==start) throw Error('访问点不得包含推算的停留时长。');
      if (end===start && basis!=='visit_events') {notices.zero++;continue;}
      if (end-start>31*DAY) throw Error(`第 ${i+1} 段超过 31 天，请核对时间字段。`);
      let url;
      try {url=new URL(row.url);if (!['http:','https:'].includes(url.protocol)) {notices.unsupported++;continue;}}
      catch {throw Error(`第 ${i+1} 段的网址无效。`);}
      sessions.push({key:`s${i}`,id:String(row.id ?? i),start,end,title:String(row.title || url.hostname),url:url.href,domain:canonicalDomain(url.href),profile:String(row.profile || 'Default')});
    }
    if (!sessions.length) throw Error('文件中没有可显示的正时长网页区间。');
    const dates=new Set();
    for (const s of sessions) {
      let day=Date.parse(localDate(s.start,offsetMs)+'T00:00:00Z'),last=Date.parse(localDate(basis==='visit_events'?s.start:s.end-1,offsetMs)+'T00:00:00Z');
      while(day<=last) {dates.add(new Date(day).toISOString().slice(0,10));day+=DAY;}
    }
    const days=[...dates].sort();
    return {sessions,source,basis,utc_offset:offset,offset:offsetMs,description,notices,days,date:validDate(requestedDate)?requestedDate:days.at(-1)};
  }
  function canonicalData() {
    return {schema:isVisits()?'daytrace.visits.v1':'daytrace.activity.v1',date:state.date,utc_offset:state.data.utc_offset,source:state.data.source==='synthetic'?'synthetic':'import',time_basis:state.data.basis,description:state.data.description,sessions:state.data.sessions.map(s=>({id:s.id,start:new Date(s.start).toISOString(),end:new Date(s.end).toISOString(),url:s.url,title:s.title,profile:s.profile}))};
  }
  function derive() {
    const {start,end}=windowBounds(),pages=new Map();
    for (const s of state.data.sessions) {
      if ((isVisits()?s.start<start:s.end<=start) || s.start>=end) continue;
      const key=JSON.stringify([s.url,s.profile]);
      if (!pages.has(key)) pages.set(key,{key,domain:s.domain,url:s.url,title:s.title,profile:s.profile,sessions:[],latest:-Infinity});
      const p=pages.get(key);
      p.sessions.push({...s,from:Math.max(start,s.start),to:Math.min(end,s.end)});
      if (s.start>=p.latest) {p.title=s.title;p.latest=s.start;}
    }
    const all=[...pages.values()];
    for (const page of all) {page.sessions.sort((a,b)=>a.from-b.from);page.first=page.sessions[0].from;page.duration=total(page.sessions);}
    state.allPages=all;
    state.pages=[...all];
    const groups=new Map();
    for (const p of state.pages) {
      if (!groups.has(p.domain)) groups.set(p.domain,{key:p.domain,domain:p.domain,pages:[],sessions:[]});
      const group=groups.get(p.domain);group.pages.push(p);group.sessions.push(...p.sessions);
    }
    const compare=(a,b)=>state.sort==='duration'?(isVisits()?b.sessions.length-a.sessions.length:b.duration-a.duration) || a.first-b.first:state.sort==='name'?(a.title || siteName(a.domain)).localeCompare(b.title || siteName(b.domain),'zh-CN'):a.first-b.first;
    state.pages.sort(compare);
    state.groups=[...groups.values()].map(g=>{g.ranges=isVisits()?[...g.sessions].sort((a,b)=>a.from-b.from):union(g.sessions);g.first=g.ranges[0].from;g.duration=total(g.ranges);g.pages.sort(compare);return g;}).sort(compare);
  }

  function bar(range,owner,isGroup=false,expanded=false) {
    const {start,end}=windowBounds(),left=(range.from-start)/(end-start)*state.plot,actual=(range.to-range.from)/(end-start)*state.plot;
    const width=Math.min(state.plot-left,Math.max(1,actual)),hit=Math.max(12,width),hitLeft=Math.max(0,Math.min(state.plot-hit,left+width/2-hit/2));
    const id='b'+state.bars.size,style=color(owner.domain).style;
    state.bars.set(id,{range,owner,isGroup});
    if(isVisits()) {
      const hitLeft=Math.max(0,Math.min(state.plot-16,left-8));
      return `<button class="interval-hit visit-hit" data-bar="${id}" data-start="${range.from}" data-end="${range.from}" aria-label="${escape(owner.title || siteName(owner.domain))}，${clock(range.from,true)} 访问" aria-pressed="${Boolean(state.selected && range.key===state.selected)}" style="left:${hitLeft}px;width:16px;${style}"><span class="visit-dot" style="left:${left-hitLeft}px"></span></button>`;
    }
    const label=`${isGroup?siteName(owner.domain):owner.title}，${clock(range.from)} 至 ${clock(range.to)}，${duration(range.to-range.from,false)}`;
    return `<button class="interval-hit" data-bar="${id}" data-start="${range.from}" data-end="${range.to}" aria-label="${escape(label)}" aria-pressed="${Boolean(state.selected && range.key===state.selected)}" style="left:${hitLeft}px;width:${hit}px;${style}"><span class="interval-bar${width<3?' short':''}" style="left:${left-hitLeft}px;transform:none;width:${width}px">${width>=48 && !expanded?`<span class="interval-text">${escape(duration(range.to-range.from))}</span>`:''}</span></button>`;
  }
  function pageRow(page,child=false) {
    return `<div class="chart-row page-row${child?' child-row':''}" data-page="${escape(page.key)}" style="${color(page.domain).style}"><div class="row-label"><button class="page-button" data-page-open="${escape(page.key)}" title="${escape(page.title)}">${avatar(page.domain)}<span class="page-title">${highlight(page.title)}</span></button>${child?'':`<span class="row-duration">${metric(page)}</span>`}</div><div class="row-track">${page.sessions.map(s=>bar(s,page)).join('')}</div></div>`;
  }
  function renderRows() {
    state.bars.clear();let html='';
    if (state.view==='page') html=state.pages.map(p=>pageRow(p)).join('');
    else for (const g of state.groups) {
      const expanded=state.expanded.has(g.domain);
      html+=`<div class="chart-row group-row${expanded?' expanded':''}" data-site="${escape(g.domain)}" style="${color(g.domain).style}"><div class="row-label"><button class="group-button" data-group="${escape(g.domain)}" aria-expanded="${expanded}" aria-label="${expanded?'收起':'展开'} ${escape(siteName(g.domain))}"><svg class="icon chevron"><use href="#i-arrow"/></svg>${avatar(g.domain)}<span class="group-name">${highlight(siteName(g.domain))}</span><span class="group-count">${g.pages.length}</span><span class="row-duration">${metric(g)}</span></button></div><div class="row-track">${g.ranges.map(s=>bar(s,g,true,expanded)).join('')}</div></div>`;
      if (expanded) html+=g.pages.map(p=>pageRow(p,true)).join('');
    }
    $('rows').innerHTML=html;
    $('empty-state').hidden=state.pages.length>0;
    $('empty-description').textContent=`${state.date} 的 06:00–24:00 没有活动区间。`;
    $('fold-all').hidden=state.view!=='site';
    const allExpanded=state.groups.length>0 && state.groups.every(g=>state.expanded.has(g.domain));
    $('fold-all').querySelector('span').textContent=allExpanded?'全部收起':'全部展开';
    $('fold-all').title=allExpanded?'全部收起':'全部展开';
    const sessions=state.pages.flatMap(p=>p.sessions),pageLabel=String(state.pages.length);
    $('record-count').innerHTML=`<b>${pageLabel}</b> 个网页<span class="count-dot">·</span><b>${sessions.length}</b> 段区间<span class="count-dot">·</span><b title="重叠区间只计一次">${duration(total(sessions))}</b>`;
    if(isVisits())$('record-count').innerHTML=`<b>${pageLabel}</b> 个网页<span class="count-dot">·</span><b>${sessions.length}</b> 次访问`;
    document.querySelector('.label-heading span:last-child').textContent=isVisits()?'访问次数':'活动时长';
    $('sort').querySelector('[value=duration]').textContent=isVisits()?'访问次数优先':'时长优先';
    $('row-heading').textContent=state.view==='site'?'网站 / 网页':'网页';
    $('view-site').setAttribute('aria-pressed',String(state.view==='site'));
    $('view-page').setAttribute('aria-pressed',String(state.view==='page'));
    hideTooltip();
  }
  function renderAxis() {
    $('periods').innerHTML=[['上午',6,12],['下午',12,18],['晚间',18,24]].map(([label,from,to])=>`<div class="day-period">${label} <span>${String(from).padStart(2,'0')}:00 — ${to}:00</span></div>`).join('');
    const step=[1,2,3,6].find(n=>state.plot/18*n>=90) || 6;
    let html='';
    for(let h=6;h<=24;h++) {
      const major=h===6 || h===24 || (h-6)%step===0;
      html+=`<div class="tick${h===6?' start':''}${h===24?' end':''}${major?'':' minor'}" style="left:${(h-6)/18*state.plot}px"><span>${String(h).padStart(2,'0')}:00</span></div>`;
    }
    $('ticks').innerHTML=html;
  }
  function renderOverview() {
    const {start,end}=windowBounds();
    $('overview-events').innerHTML=state.pages.flatMap(p=>p.sessions.map(s=>`<span class="overview-event" style="left:${(s.from-start)/(end-start)*100}%;width:${Math.max(.08,(s.to-s.from)/(end-start)*100)}%;--accent:${color(p.domain).accent}"></span>`)).join('');
    updateOverview();
  }
  function updateOverview() {
    const scroll=$('chart-scroll'),available=Math.max(1,scroll.clientWidth-labelWidth());
    $('overview-window').style.left=`${scroll.scrollLeft/state.plot*100}%`;
    $('overview-window').style.width=`${Math.min(100,available/state.plot*100)}%`;
  }
  function labelWidth() {return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-width'));}
  function measure() {
    const base=Math.max(400,$('chart-scroll').clientWidth-labelWidth());
    state.plot=base*state.zoom;
    document.documentElement.style.setProperty('--plot-width',state.plot+'px');
    document.documentElement.style.setProperty('--hour-width',state.plot/18+'px');
  }
  function render({deriveData=true}={}) {
    const sc=$('chart-scroll'),top=sc.scrollTop,left=sc.scrollLeft;
    if (deriveData) derive();measure();renderAxis();renderRows();renderOverview();
    sc.scrollTop=top;sc.scrollLeft=left;updateOverview();
    $('zoom-reset').textContent=Math.round(state.zoom*100)+'%';
    $('zoom-out').disabled=state.zoom<=1;$('zoom-in').disabled=state.zoom>=8;
    syncSelection();
  }
  function zoom(next,clientX) {
    const sc=$('chart-scroll'),label=labelWidth(),rect=sc.getBoundingClientRect(),available=sc.clientWidth-label;
    const anchor=clientX===undefined?available/2:Math.max(0,Math.min(available,clientX-rect.left-label));
    const fraction=(sc.scrollLeft+anchor)/state.plot;
    state.zoom=Math.max(1,Math.min(8,next));render({deriveData:false});
    sc.scrollLeft=Math.max(0,fraction*state.plot-anchor);updateOverview();
  }
  function renderHeader() {
    const displayDate=new Date(state.date+'T12:00:00Z');
    $('date-text').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',timeZone:'UTC'}).format(displayDate);
    $('day-context').textContent=state.date.slice(0,4)+'年 · '+new Intl.DateTimeFormat('zh-CN',{weekday:'long',timeZone:'UTC'}).format(displayDate);
    $('date-input').value=state.date;
    $('date-input').min=state.data.days[0];$('date-input').max=state.data.days.at(-1);
    $('previous-day').disabled=!state.data.days.some(d=>d<state.date);
    $('next-day').disabled=!state.data.days.some(d=>d>state.date);
  }
  function selectDate(date) {
    if (!validDate(date)) return;
    state.date=date;closeDrawer();renderHeader();render();$('chart-scroll').scrollLeft=0;$('chart-scroll').scrollTop=0;
  }
  function toast(message,error=false) {
    clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;
    toastTimer=setTimeout(()=>$('toast').hidden=true,6000);
  }
  let tooltipTimer,tooltipWarmUntil=0;
  function hideTooltip() {clearTimeout(tooltipTimer);if(!$('tooltip').hidden)tooltipWarmUntil=performance.now()+500;$('tooltip').hidden=true;}
  function scheduleTooltip(button,event) {
    clearTimeout(tooltipTimer);
    const point={clientX:event.clientX,clientY:event.clientY};
    if(!$('tooltip').hidden || performance.now()<tooltipWarmUntil){showTooltip(button,point);return;}
    tooltipTimer=setTimeout(()=>{if(button.isConnected)showTooltip(button,point);},220);
  }
  function showTooltip(button,event) {
    const item=state.bars.get(button.dataset.bar);if (!item) return;
    const {range,owner,isGroup}=item;
    $('tooltip').innerHTML=`<div class="tooltip-heading">${avatar(owner.domain)}${escape(siteName(owner.domain))}${isGroup?`<span style="margin-left:auto">${owner.pages.length} 个网页</span>`:''}</div><h3>${highlight(isGroup?siteName(owner.domain):range.title || owner.title)}</h3><div class="tooltip-stats"><div><span>开始</span><b>${clock(range.from)}</b></div><div><span>结束</span><b>${clock(range.to)}</b></div><div><span>时长</span><b>${escape(duration(range.to-range.from))}</b></div></div>${isGroup?'<p class="tooltip-note">网站概览 · 相邻区间合并，空档保留</p>':''}`;
    if(isVisits())$('tooltip').innerHTML=`<div class="tooltip-heading">${avatar(owner.domain)}${escape(siteName(owner.domain))}</div><h3>${escape(range.title || owner.title)}</h3><div>${clock(range.from,true)} · 访问</div>`;
    const tip=$('tooltip');tip.hidden=false;
    const rect=button.getBoundingClientRect(),x=event?.clientX ?? rect.left+rect.width/2,y=event?.clientY ?? rect.top;
    tip.style.left=Math.max(12,Math.min(innerWidth-tip.offsetWidth-12,x+16))+'px';
    tip.style.top=(y-tip.offsetHeight-15>10?y-tip.offsetHeight-15:Math.min(innerHeight-tip.offsetHeight-12,y+22))+'px';
  }
  // A critically damped spring retains position and velocity when retargeted.
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  const inspector={position:0,velocity:0,target:0,frame:0,last:0};
  let contentMotion;
  function resizeTimeline() {
    const sc=$('chart-scroll'),fraction=state.plot?sc.scrollLeft/state.plot:0;
    measure();
    const step=[1,2,3,6].find(n=>state.plot/18*n>=90) || 6;
    [...$('ticks').children].forEach((tick,i)=>{
      tick.style.left=i/18*state.plot+'px';
      tick.classList.toggle('minor',i!==0 && i!==18 && i%step!==0);
    });
    const {start,end}=windowBounds();
    for(const button of $('rows').querySelectorAll('[data-bar]')) {
      const item=state.bars.get(button.dataset.bar);if(!item)continue;
      const left=(item.range.from-start)/(end-start)*state.plot;
      const width=Math.min(state.plot-left,Math.max(1,(item.range.to-item.range.from)/(end-start)*state.plot));
      if(isVisits()){const hitLeft=Math.max(0,Math.min(state.plot-16,left-8));button.style.left=hitLeft+'px';button.style.width='16px';button.firstElementChild.style.left=left-hitLeft+'px';continue;}
      const hit=Math.max(12,width),hitLeft=Math.max(0,Math.min(state.plot-hit,left+width/2-hit/2));
      button.style.left=hitLeft+'px';button.style.width=hit+'px';
      const bar=button.firstElementChild;
      bar.style.left=left-hitLeft+'px';bar.style.width=width+'px';bar.classList.toggle('short',width<3);
      const showText=width>=48 && !button.closest('.expanded');
      if(showText && !bar.firstElementChild){const text=document.createElement('span');text.className='interval-text';text.textContent=duration(item.range.to-item.range.from);bar.append(text);}
      else if(!showText && bar.firstElementChild)bar.replaceChildren();
    }
    sc.scrollLeft=fraction*state.plot;updateOverview();
  }
  function paintInspector() {
    const x=inspector.position,drawer=$('drawer');
    document.documentElement.style.setProperty('--inspector-space',404*x+'px');
    drawer.style.transform=`translateX(${44*(1-x)}px) scale(${.98+.02*x})`;
    drawer.style.opacity=String(x);
    resizeTimeline();
  }
  function finishInspector() {
    inspector.position=inspector.target;inspector.velocity=0;inspector.frame=0;paintInspector();
    if(!inspector.target)$('drawer').hidden=true;
    $('drawer').style.willChange='';
  }
  function moveInspector(open) {
    inspector.target=open?1:0;
    document.documentElement.classList.toggle('inspector-open',open);
    $('drawer').inert=!open;
    if(open)$('drawer').hidden=false;
    hideTooltip();$('cursor-line').hidden=true;$('cursor-time').hidden=true;
    if(reducedMotion.matches){cancelAnimationFrame(inspector.frame);finishInspector();return;}
    if(inspector.frame)return;
    if(inspector.position===inspector.target)return;
    $('drawer').style.willChange='transform, opacity';
    inspector.last=performance.now();paintInspector();
    function step(now) {
      const dt=Math.min((now-inspector.last)/1000,.05);inspector.last=now;
      // Exact critically damped solution; stable even when a frame is delayed.
      const omega=26,offset=inspector.position-inspector.target;
      const impulse=inspector.velocity+omega*offset,decay=Math.exp(-omega*dt);
      inspector.position=inspector.target+(offset+impulse*dt)*decay;
      inspector.velocity=(inspector.velocity-omega*impulse*dt)*decay;
      if(Math.abs(inspector.position-inspector.target)<.0005 && Math.abs(inspector.velocity)<.01){finishInspector();return;}
      paintInspector();inspector.frame=requestAnimationFrame(step);
    }
    inspector.frame=requestAnimationFrame(step);
  }
  reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches && inspector.frame){cancelAnimationFrame(inspector.frame);finishInspector();}contentMotion?.cancel();});
  function closeDrawer() {
    if (!inspector.target) return;
    const focusBar=state.returnFocus?.dataset?.bar;
    $('drawer-backdrop').hidden=true;state.selected=null;
    moveInspector(false);
    document.querySelectorAll('.interval-hit[aria-pressed=true]').forEach(b=>b.setAttribute('aria-pressed','false'));
    const replacement=[...document.querySelectorAll('[data-bar]')].find(b=>b.dataset.bar===focusBar);
    if (state.returnFocus?.isConnected) state.returnFocus.focus();else if(replacement)replacement.focus({preventScroll:true});else $('chart-scroll').focus();
  }
  function syncSelection() {
    document.querySelectorAll('.interval-hit').forEach(b=>b.setAttribute('aria-pressed',String(state.bars.get(b.dataset.bar)?.range.key===state.selected && state.selected!==null)));
  }
  function openDetail(owner,isGroup=false,range=null) {
    hideTooltip();state.returnFocus=document.activeElement?.closest('[data-bar],[data-page-open]') || state.returnFocus;state.selected=range?.key || null;
    $('drawer-site').innerHTML=avatar(owner.domain)+escape(siteName(owner.domain));
    const switching=Boolean(inspector.target);
    $('drawer').style.setProperty('--halo',color(owner.domain).accent+'25');
    for(const [name,value] of Object.entries(color(owner.domain)))if(name!=='style')$('drawer').style.setProperty('--'+name,value);
    const note=isVisits()?'Edge 历史仅记录访问时间，未记录停留时长。':state.data.source==='synthetic'?'当前为合成示例区间，不代表真实浏览或学习。':state.data.basis==='raw_browser_events'?'这些是浏览器原始事件，未扣除其他应用在前台或空闲的时间。':'区间含义由采集来源定义；页面显示活动记录，不判断是否在学习。';
    let content=`<h2 id="drawer-title">${highlight(isGroup?siteName(owner.domain):owner.title)}</h2>`;
    if (!isGroup) content+=`<a class="drawer-url" href="${escape(owner.url)}" target="_blank" rel="noopener noreferrer">${symbol('link')}<span>${highlight(owner.url)}</span></a>`;
    content+=`<div class="detail-stats"><div><b>${escape(isVisits()?String(owner.sessions.length):duration(owner.duration))}</b><span>${isVisits()?'次访问':'区间时长 · 重叠仅计一次'}</span></div><div><b>${isGroup?owner.pages.length:isVisits()?'—':owner.sessions.length}</b><span>${isGroup?'个网页':isVisits()?'停留时长未知':'段独立区间'}</span></div></div>`;
    if (isGroup) content+=`<h3 class="detail-section-title">具体网页<span>${state.date}</span></h3><div class="drawer-pages">${owner.pages.map(p=>`<button class="drawer-page" data-detail-page="${escape(p.key)}"><span>${highlight(p.title)}</span><b>${metric(p)}</b></button>`).join('')}</div>`;
    else if(isVisits())content+=`<h3 class="detail-section-title">访问记录<span>${state.date}</span></h3><div class="session-list">${owner.sessions.map(s=>`<div class="session-entry${range?.key===s.key?' active':''}" data-detail-session="${escape(s.key)}"><div class="session-time"><time>${clock(s.from,true)}</time><b>访问</b></div></div>`).join('')}</div>`;
    else content+=`<h3 class="detail-section-title">活动区间<span>${state.date}</span></h3><div class="session-list">${owner.sessions.map(s=>`<div class="session-entry${range?.key===s.key?' active':''}" data-detail-session="${escape(s.key)}"><div class="session-time"><time>${clock(s.from,true)}</time><span>—</span><time>${clock(s.to,true)}</time><b>${duration(s.to-s.from)}</b></div>${s.from!==s.start || s.to!==s.end?`<div class="session-evidence">已按 06:00–24:00 裁切；原始 ${escape(new Date(s.start).toISOString())} — ${escape(new Date(s.end).toISOString())}</div>`:''}</div>`).join('')}</div>`;
    content+=`<p class="detail-note">${note}</p>`;
    const changing=contentMotion?.playState==='running';
    const currentOpacity=changing?getComputedStyle($('drawer-content')).opacity:'.55';
    const currentTransform=changing?getComputedStyle($('drawer-content')).transform:'translateY(6px)';
    contentMotion?.cancel();
    $('drawer-content').innerHTML=content;$('drawer-backdrop').hidden=true;
    moveInspector(true);$('drawer-close').focus({preventScroll:true});
    $('drawer').scrollTop=0;
    if(switching && !reducedMotion.matches)contentMotion=$('drawer-content').animate(
      [{opacity:currentOpacity,transform:currentTransform},{opacity:1,transform:'translateY(0)'}],
      {duration:160,easing:'cubic-bezier(.2,.8,.2,1)'});
    if (range?.key) $('drawer-content').querySelector('.session-entry.active')?.scrollIntoView({block:'nearest'});
    document.querySelectorAll('.interval-hit').forEach(b=>b.setAttribute('aria-pressed',String(state.bars.get(b.dataset.bar)?.range.key===state.selected && state.selected!==null)));
  }

  $('view-site').addEventListener('click',()=>{state.view='site';render({deriveData:false});});
  $('view-page').addEventListener('click',()=>{state.view='page';render({deriveData:false});});
  $('sort').addEventListener('change',event=>{state.sort=event.target.value;render();});
  $('fold-all').addEventListener('click',()=>{const all=state.groups.every(g=>state.expanded.has(g.domain));for(const g of state.groups)all?state.expanded.delete(g.domain):state.expanded.add(g.domain);render({deriveData:false});});
  $('rows').addEventListener('click',event=>{
    const group=event.target.closest('[data-group]');if(group){const domain=group.dataset.group;state.expanded.has(domain)?state.expanded.delete(domain):state.expanded.add(domain);render({deriveData:false});[...document.querySelectorAll('[data-group]')].find(b=>b.dataset.group===domain)?.focus({preventScroll:true});return;}
    const page=event.target.closest('[data-page-open]');if(page){openDetail(state.pages.find(p=>p.key===page.dataset.pageOpen));return;}
    const button=event.target.closest('[data-bar]');if(button){const item=state.bars.get(button.dataset.bar);openDetail(item.owner,item.isGroup,item.range);}
  });
  $('rows').addEventListener('pointerover',event=>{const button=event.target.closest('[data-bar]');if(button && !button.contains(event.relatedTarget))scheduleTooltip(button,event);});
  $('rows').addEventListener('pointerout',event=>{if(event.target.closest('[data-bar]') && !event.relatedTarget?.closest?.('[data-bar]'))hideTooltip();});
  $('rows').addEventListener('focusin',event=>{if(event.target.matches('[data-bar]'))showTooltip(event.target);});
  $('rows').addEventListener('focusout',hideTooltip);
  $('rows').addEventListener('keydown',event=>{
    if(!event.target.matches('[data-bar]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=[...event.target.closest('.row-track').querySelectorAll('[data-bar]')],i=buttons.indexOf(event.target);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,i+(event.key==='ArrowRight'?1:-1)));
    event.preventDefault();buttons[next].focus();
  });
  $('zoom-in').addEventListener('click',()=>zoom(state.zoom*1.5));
  $('zoom-out').addEventListener('click',()=>zoom(state.zoom/1.5));
  $('zoom-reset').addEventListener('click',()=>{zoom(1);$('chart-scroll').scrollLeft=0;updateOverview();});
  $('chart-scroll').addEventListener('wheel',event=>{if(event.ctrlKey || event.metaKey){event.preventDefault();zoom(state.zoom*(event.deltaY<0?1.2:1/1.2),event.clientX);}},{passive:false});
  $('chart-scroll').addEventListener('dblclick',event=>{if(event.target.closest('.axis,.row-track') && !event.target.closest('[data-bar]'))zoom(state.zoom*1.5,event.clientX);});
  $('chart-scroll').addEventListener('scroll',()=>{updateOverview();hideTooltip();$('cursor-line').hidden=true;$('cursor-time').hidden=true;},{passive:true});
  $('chart-scroll').addEventListener('pointermove',event=>{
    const rect=$('chart-scroll').getBoundingClientRect(),localX=event.clientX-rect.left-labelWidth();
    if(localX<0){$('cursor-line').hidden=true;$('cursor-time').hidden=true;return;}
    const x=Math.min(state.plot,localX+$('chart-scroll').scrollLeft),{start,end}=windowBounds();
    $('cursor-line').hidden=false;$('cursor-line').style.left=labelWidth()+x+'px';
    $('cursor-time').hidden=false;$('cursor-time').style.left=Math.max(32,Math.min(state.plot-32,x))+'px';$('cursor-time').textContent=clock(start+x/state.plot*(end-start));
  });
  $('chart-scroll').addEventListener('pointerleave',()=>{$('cursor-line').hidden=true;$('cursor-time').hidden=true;hideTooltip();});
  $('overview-track').addEventListener('click',event=>{const rect=event.currentTarget.getBoundingClientRect(),fraction=(event.clientX-rect.left)/rect.width;if(state.zoom===1)zoom(2);$('chart-scroll').scrollLeft=fraction*state.plot-($('chart-scroll').clientWidth-labelWidth())/2;updateOverview();});
  $('previous-day').addEventListener('click',()=>selectDate(state.data.days.filter(d=>d<state.date).at(-1)));
  $('next-day').addEventListener('click',()=>selectDate(state.data.days.find(d=>d>state.date)));
  $('date-input').addEventListener('change',event=>selectDate(event.target.value));
  $('drawer-close').addEventListener('click',closeDrawer);$('drawer-backdrop').addEventListener('click',closeDrawer);
  $('drawer-content').addEventListener('click',event=>{const button=event.target.closest('[data-detail-page]');if(button)openDetail(state.pages.find(p=>p.key===button.dataset.detailPage));});
  $('file-input').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{
      if(file.size>20*1024*1024)throw Error('原型单次最多导入 20 MB JSON。');
      const next=normalize(JSON.parse((await file.text()).replace(/^\uFEFF/,'')));
      closeDrawer();state.data=next;state.date=next.date;state.selected=null;state.zoom=1;state.expanded.clear();
      renderHeader();render();$('chart-scroll').scrollLeft=0;$('chart-scroll').scrollTop=0;toast('已在本地载入活动区间');
    }catch(error){toast('无法导入：'+error.message,true);}
    event.target.value='';
  });
  $('save-button').addEventListener('click',()=>{
    $('options-menu').open=false;
    const clone=document.documentElement.cloneNode(true);
    clone.classList.remove('inspector-open');
    clone.style.removeProperty('--inspector-space');
    clone.querySelector('#drawer').style.transform='';
    clone.querySelector('#drawer').style.opacity='';
    clone.querySelector('#drawer').style.willChange='';
    clone.querySelector('#activity-data').textContent=JSON.stringify(canonicalData()).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
    for(const id of ['drawer','drawer-backdrop','tooltip','toast','cursor-line','cursor-time'])clone.querySelector('#'+id).hidden=true;
    const blob=new Blob(['<!doctype html>\n'+clone.outerHTML],{type:'text/html;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='pageago-activity-'+state.date+'.html';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('已保存为可离线打开的独立网页');
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape') {
      if($('options-menu').open){event.preventDefault();$('options-menu').open=false;$('options-trigger').focus();}
      else if(!$('drawer').hidden){event.preventDefault();closeDrawer();}
      hideTooltip();
    }
  });
  document.addEventListener('pointerdown',event=>{if(!$('options-menu').contains(event.target))$('options-menu').open=false;});
  $('options-menu').addEventListener('focusout',()=>{queueMicrotask(()=>{if(!$('options-menu').contains(document.activeElement))$('options-menu').open=false;});});
  new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(state.data && !inspector.frame && Math.abs(Math.max(400,$('chart-scroll').clientWidth-labelWidth())*state.zoom-state.plot)>.5)resizeTimeline();});}).observe($('chart-scroll'));
  state.data=normalize(JSON.parse($('activity-data').textContent));state.date=state.data.date;
  renderHeader();render();
  // Read-only hook for browser QA; never exposes original page content or makes requests.
  window.activitySnapshot=()=>({source:state.data.source,basis:state.data.basis,date:state.date,view:state.view,zoom:state.zoom,pages:state.pages.length,allPages:state.allPages.length,sites:state.groups.length,sessions:state.pages.reduce((n,p)=>n+p.sessions.length,0),duration:isVisits()?null:total(state.pages.flatMap(p=>p.sessions)),rows:document.querySelectorAll('.chart-row').length,start:windowBounds().start,end:windowBounds().end});
})();
