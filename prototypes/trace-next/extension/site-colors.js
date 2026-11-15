/* Stable local website colors. No network, DOM, or browser permissions required.
 * OKLab matrices: Björn Ottosson's public-domain reference implementation,
 * https://bottosson.github.io/posts/oklab/ . Distances are an approximation of
 * perceptual separation, not a promise that arbitrary numbers of colors differ
 * equally for every viewer. Website icons and titles remain the primary labels.
 */
(() => {
  'use strict';
  const VERSION=1,DEFAULT_KEY='trace.site-colors.v1',FALLBACK='#708fa6';
  const distance=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2;
  const hash=value=>{let h=2166136261;for(const c of value)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;};
  const domainKey=value=>typeof value==='string'&&value.length<=255&&!/[\s\u0000-\u001f\u007f/\\?#]/.test(value)?value.toLowerCase().replace(/\.$/,''):'';
  const linear=value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
  const encoded=value=>value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055;
  function toLab(hex){
    const [r,g,b]=[1,3,5].map(i=>linear(parseInt(hex.slice(i,i+2),16)/255));
    const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b);
    const m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b);
    const s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
    return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];
  }
  function candidate(L,C,h){
    const a=C*Math.cos(h*Math.PI/180),b=C*Math.sin(h*Math.PI/180);
    const l=(L+.3963377774*a+.2158037573*b)**3,m=(L-.1055613458*a-.0638541728*b)**3,s=(L-.0894841775*a-1.291485548*b)**3;
    const rgb=[4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s];
    // Reject out-of-gamut candidates instead of clipping different colors together.
    if(rgb.some(c=>c<0||c>1))return null;
    const hex='#'+rgb.map(c=>Math.round(encoded(c)*255).toString(16).padStart(2,'0')).join('');
    return {hex,lab:toLab(hex)};
  }
  const base=[];
  {
    const seen=new Set();
    for(const L of [.56,.605,.65,.695,.74])for(const C of [.055,.075,.095,.115])for(let h=0;h<360;h+=5){
      const value=candidate(L,C,h);if(value&&!seen.has(value.hex)){seen.add(value.hex);base.push(value);}
    }
  }
  function radicalInverse(index,base){let result=0,factor=1/base;while(index){result+=(index%base)*factor;index=Math.floor(index/base);factor/=base;}return result;}
  function create({storage=null,key=DEFAULT_KEY}={}){
    const assigned=new Map(),used=new Set();
    let pool=[],poolHexes=new Set(),extensionIndex=1,lastStored;
    function resetPool(){pool=base.map(c=>({...c,nearest:Infinity}));poolHexes=new Set(pool.map(c=>c.hex));extensionIndex=1;}
    resetPool();
    function occupy(domain,hex){
      assigned.set(domain,hex);used.add(hex);const lab=toLab(hex);
      for(const value of pool)value.nearest=Math.min(value.nearest,distance(lab,value.lab));
    }
    function sync(){
      if(!storage)return;
      try{
        const raw=storage.getItem(key);if(raw===lastStored)return;
        const removed=raw===null&&lastStored!=null;lastStored=raw;
        // A different preview can clear this preference. Do not bring previously
        // saved domain names back on the next write from a still-open preview.
        if(removed){assigned.clear();used.clear();resetPool();return;}
        if(!raw||raw.length>5000000)return;
        const state=JSON.parse(raw);if(state?.version!==VERSION||!Array.isArray(state.entries))return;
        // Array pairs and Maps also keep names such as '__proto__' harmless.
        for(const entry of state.entries.slice(0,100000)){
          if(!Array.isArray(entry)||entry.length!==2)continue;
          const domain=domainKey(entry[0]),hex=typeof entry[1]==='string'?entry[1].toLowerCase():'';
          if(!domain||assigned.has(domain)||!/^#[0-9a-f]{6}$/.test(hex)||used.has(hex))continue;
          const lab=toLab(hex),chroma=Math.hypot(lab[1],lab[2]);
          if(lab[0]<.555||lab[0]>.745||chroma<.05||chroma>.12)continue;
          occupy(domain,hex);
        }
      }catch{/* A denied or malformed preference must never prevent rendering. */}
    }
    function save(){
      if(!storage)return;
      try{const raw=JSON.stringify({version:VERSION,entries:[...assigned]});storage.setItem(key,raw);lastStored=raw;}
      catch{/* Quota/private-mode failures retain the current in-memory mapping. */}
    }
    function extendPool(){
      // Refine the same muted gamut without a fixed site-count limit or a cycle
      // back to the first twelve colors. All candidates are unique display hexes.
      const labs=[...assigned.values()].map(toLab);let added=0,attempts=0;
      while(added<512&&attempts++<20000){
        const n=extensionIndex++,value=candidate(.56+.18*radicalInverse(n,2),.055+.06*radicalInverse(n,3),360*((n*.618033988749895)%1));
        if(!value||poolHexes.has(value.hex))continue;
        let nearest=Infinity;for(const lab of labs)nearest=Math.min(nearest,distance(lab,value.lab));
        pool.push({...value,nearest});poolHexes.add(value.hex);added++;
      }
      return added;
    }
    function assign(domain){
      let best=null,bestScore=-1,bestTie=-1;
      for(const value of pool){
        if(used.has(value.hex))continue;
        const score=value.nearest,tie=hash(domain+'\0'+value.hex);
        if(score>bestScore||score===bestScore&&tie>bestTie){best=value;bestScore=score;bestTie=tie;}
      }
      if(!best){
        if(extendPool())return assign(domain);
        // The finite sRGB gamut can eventually be exhausted. Keep a deterministic
        // fallback rather than blocking the timeline or altering existing sites.
        const fallback=base[hash(domain)%base.length].hex;occupy(domain,fallback);return;
      }
      occupy(domain,best.hex);
    }
    sync();
    function prepare(domains){
      sync();const unknown=new Set();
      for(const value of domains||[]){const domain=domainKey(value);if(domain&&!assigned.has(domain))unknown.add(domain);}
      if(!unknown.size)return;
      for(const domain of [...unknown].sort())assign(domain);
      save();
    }
    function color(value){const domain=domainKey(value);if(!domain)return FALLBACK;if(!assigned.has(domain))prepare([domain]);return assigned.get(domain);}
    function clear(){
      assigned.clear();used.clear();resetPool();lastStored=null;
      try{storage?.removeItem(key);return true;}
      catch{storage=null;return false;}
    }
    return Object.freeze({prepare,color,clear});
  }
  globalThis.TraceSiteColors=Object.freeze({create});
})();
