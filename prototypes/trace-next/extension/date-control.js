/* Local dates, a small segmented dial, and a keyboard-accessible calendar. */
(() => {
  'use strict';
  const key=d=>`${String(d.getFullYear()).padStart(4,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const parse=s=>new Date(s+'T12:00:00');
  const shift=(s,days)=>{const d=parse(s);d.setDate(d.getDate()+days);return key(d);};
  const monthOf=s=>s.slice(0,7)+'-01';
  const monthShift=(s,n)=>{const d=parse(s),day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+n);d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));return key(d);};
  const label=s=>{const d=parse(s);return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;};
  const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.setAttribute('aria-hidden','true');svg.append(use);return svg;}
  function create({root,today,onChange,onOpen=()=>{}}){
    let selected='',month='',focusDay='',open=false;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    let capsule=null;
    const previous=make('button','date-step'),trigger=make('button','date-trigger'),next=make('button','date-step');
    previous.id='date-previous';previous.setAttribute('aria-label','前一天');const previousFace=make('span','date-step-face');previousFace.append(icon('back'));previous.append(previousFace);
    next.id='date-next';next.setAttribute('aria-label','后一天');const nextFace=make('span','date-step-face');nextFace.append(icon('next'));next.append(nextFace);
    trigger.id='date-trigger';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls','date-popover');trigger.setAttribute('aria-expanded','false');
    const monthPart=make('span','date-month'),dayPart=make('span','date-day'),calendarPart=make('span','date-calendar');
    monthPart.setAttribute('aria-hidden','true');dayPart.setAttribute('aria-hidden','true');calendarPart.setAttribute('aria-hidden','true');trigger.append(monthPart,dayPart,calendarPart);
    calendarPart.append(icon('calendar'));
    const popup=make('div','date-popover');popup.id='date-popover';popup.hidden=true;popup.setAttribute('role','dialog');popup.setAttribute('aria-label','选择日期');
    const header=make('div','calendar-header'),prevMonth=make('button','calendar-step'),monthLabel=make('span'),nextMonth=make('button','calendar-step');
    prevMonth.id='calendar-prev';prevMonth.setAttribute('aria-label','上个月');prevMonth.append(icon('back'));
    nextMonth.id='calendar-next';nextMonth.setAttribute('aria-label','下个月');nextMonth.append(icon('next'));
    monthLabel.id='calendar-month';monthLabel.setAttribute('aria-live','polite');header.append(prevMonth,monthLabel,nextMonth);
    const weekdays=make('div','calendar-weekdays');weekdays.setAttribute('aria-hidden','true');for(const day of ['一','二','三','四','五','六','日'])weekdays.append(make('span','',day));
    const grid=make('div','calendar-days');grid.setAttribute('role','group');grid.setAttribute('aria-label','日期');
    const footer=make('div','calendar-footer'),goToday=make('button','','今天'),closeButton=make('button','','关闭');
    const settings=make('button','','设置');
    settings.id='settings-button';settings.setAttribute('aria-haspopup','dialog');settings.setAttribute('aria-controls','settings-dialog');
    goToday.id='calendar-today';closeButton.id='calendar-close';footer.append(goToday,settings,closeButton);
    popup.append(header,weekdays,grid,footer);root.append(previous,trigger,next,popup);
    try{capsule=window.TraceDateCapsuleThree?.create({host:trigger})||null;}catch{}
    if(!capsule)trigger.dataset.renderer='fallback';
    function close(restore=false){open=false;popup.hidden=true;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus({preventScroll:true});}
    function position(){
      if(!open)return;const r=trigger.getBoundingClientRect(),margin=14,width=Math.min(304,innerWidth-margin*2);
      popup.style.width=width+'px';popup.style.maxHeight=(innerHeight-margin*2)+'px';
      popup.style.left=Math.max(margin,Math.min(innerWidth-margin-width,r.left))+'px';
      popup.style.top=Math.max(margin,Math.min(innerHeight-margin-popup.offsetHeight,r.top-popup.offsetHeight-12))+'px';
    }
    function renderCalendar(focus=false){
      const d=parse(month),max=today();monthLabel.textContent=`${d.getFullYear()}年${d.getMonth()+1}月`;
      nextMonth.disabled=month>=monthOf(max);grid.replaceChildren();
      const first=shift(month,-((d.getDay()+6)%7));
      for(let i=0;i<42;i++){
        const value=shift(first,i),button=make('button','calendar-day',String(parse(value).getDate()));button.dataset.date=value;
        button.classList.toggle('outside-month',monthOf(value)!==month);button.classList.toggle('is-selected',value===selected);
        button.setAttribute('aria-label',label(value));button.setAttribute('aria-pressed',value===selected);if(value===max)button.setAttribute('aria-current','date');
        button.disabled=value>max;button.tabIndex=value===focusDay&&!button.disabled?0:-1;
        button.onclick=()=>choose(value);button.onfocus=()=>{focusDay=value;for(const n of grid.children)n.tabIndex=n===button?0:-1;};grid.append(button);
      }
      position();if(focus)grid.querySelector(`[data-date="${focusDay}"]`)?.focus({preventScroll:true});
    }
    function choose(value){if(value>today())return;close(open);onChange(value);}
    function show(){
      if(open){close(true);return;}onOpen();month=monthOf(selected);focusDay=selected>today()?today():selected;open=true;popup.hidden=false;trigger.setAttribute('aria-expanded','true');renderCalendar(true);
      if(!reduced.matches)popup.animate([{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:150,easing:'cubic-bezier(.2,.7,.2,1)'});
    }
    function update(value){
      const previousValue=selected,changed=previousValue!==value,initial=!previousValue;
      const direction=initial||value>=previousValue?1:-1,monthChanged=!initial&&monthOf(previousValue)!==monthOf(value);
      selected=value;
      if(changed){
        const d=parse(value),values={month:`${d.getMonth()+1}月`,day:String(d.getDate()).padStart(2,'0')};
        monthPart.textContent=values.month;dayPart.textContent=values.day;
        capsule?.update(values,{initial,monthChanged,direction,reduced:reduced.matches});if(open)close();
      }
      trigger.setAttribute('aria-label',`${label(value)}，选择日期`);next.disabled=value>=today();
    }
    previous.onclick=()=>choose(shift(selected,-1));next.onclick=()=>choose(shift(selected,1));trigger.onclick=show;
    prevMonth.onclick=()=>{month=monthOf(monthShift(month,-1));focusDay=month;renderCalendar();};
    nextMonth.onclick=()=>{if(nextMonth.disabled)return;month=monthOf(monthShift(month,1));focusDay=month;renderCalendar();};
    goToday.onclick=()=>choose(today());closeButton.onclick=()=>close(true);
    popup.onkeydown=e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);return;}
      if(!e.target.matches('.calendar-day')||e.altKey||e.ctrlKey||e.metaKey)return;
      const moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};let destination;
      if(e.key in moves)destination=shift(focusDay,moves[e.key]);
      else if(e.key==='PageUp'||e.key==='PageDown')destination=monthShift(focusDay,e.key==='PageUp'?-1:1);
      else if(e.key==='Home'||e.key==='End'){const weekday=(parse(focusDay).getDay()+6)%7;destination=shift(focusDay,e.key==='Home'?-weekday:6-weekday);}
      else return;e.preventDefault();e.stopPropagation();focusDay=destination>today()?today():destination;month=monthOf(focusDay);renderCalendar(true);
    };
    document.addEventListener('pointerdown',e=>{if(open&&!root.contains(e.target))close();});
    document.addEventListener('focusin',e=>{if(open&&!root.contains(e.target))close();});
    addEventListener('resize',position);addEventListener('scroll',position,{passive:true});
    const release=()=>capsule?.setPressed(false);
    trigger.addEventListener('pointerdown',e=>{if(e.button===0)capsule?.setPressed(true);});
    trigger.addEventListener('pointerleave',release);trigger.addEventListener('pointercancel',release);
    addEventListener('pointerup',release);addEventListener('blur',release);
    trigger.addEventListener('keydown',e=>{if(e.key===' '||e.key==='Enter')capsule?.setPressed(true);});
    addEventListener('keyup',release);
    document.addEventListener('visibilitychange',()=>{if(document.hidden){release();capsule?.finish();}});
    reduced.addEventListener('change',()=>{capsule?.update({month:monthPart.textContent,day:dayPart.textContent},{initial:true,reduced:reduced.matches});if(reduced.matches)popup.getAnimations().forEach(animation=>animation.finish());});
    return {update,close,isOpen:()=>open,snapshot:()=>capsule?.snapshot()||{backend:'fallback',revision:null,angles:[0,0,0],rolling:[false,false,false],values:{month:monthPart.textContent,day:dayPart.textContent},pressed:false}};
  }
  window.TraceDateControl={create};
})();
