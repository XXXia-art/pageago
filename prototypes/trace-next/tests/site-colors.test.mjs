import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../site-colors.js',import.meta.url),'utf8');
function api(){const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});vm.runInContext(source,context);return context.TraceSiteColors;}
function store(){const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};}
const sites=n=>Array.from({length:n},(_,i)=>`site-${String(i).padStart(3,'0')}.example`);
const colors=(allocator,domains)=>domains.map(domain=>allocator.color(domain));

// Standard sRGB -> OKLab, calculated independently from the exported CSS colors.
function lab(hex){
  const rgb=hex.match(/[0-9a-f]{2}/g).map(s=>parseInt(s,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
  const matrices=[[.4122214708,.5363325363,.0514459929],[.2119034982,.6806995451,.1073969566],[.0883024619,.2817188376,.6299787005]];
  const lms=matrices.map(row=>Math.cbrt(row.reduce((sum,v,i)=>sum+v*rgb[i],0)));
  return [[.2104542553,.793617785,-.0040720468],[1.9779984951,-2.428592205,.4505937099],[.0259040371,.7827717662,-.808675766]].map(row=>row.reduce((sum,v,i)=>sum+v*lms[i],0));
}
function separation(values){const points=values.map(lab);let min=Infinity;for(let i=0;i<points.length;i++)for(let j=0;j<i;j++)min=Math.min(min,Math.hypot(...points[i].map((v,k)=>v-points[j][k])));return min;}

test('24 and 60 sites get distinct muted colors, improving the old 12-color collisions',()=>{
  const original=['#708fa6','#828aa8','#9a85a6','#b48094','#b67f6c','#bd976f','#b3a365','#969e70','#7d987b','#6e9990','#79a0aa','#a18b78'];
  for(const size of [24,60]){
    const allocator=api().create(),domains=sites(size);allocator.prepare(domains);const values=colors(allocator,domains);
    assert.equal(new Set(values).size,size);
    const minimum=separation(values);assert.ok(minimum>(size===24?.055:.035),`${size} sites minimum OKLab separation is ${minimum}`);
    assert.ok(minimum>separation(domains.map((_,i)=>original[i%12])));
    for(const hex of values){assert.match(hex,/^#[0-9a-f]{6}$/);const [L,a,b]=lab(hex);assert.ok(L>=.555&&L<=.745);assert.ok(Math.hypot(a,b)>=.05&&Math.hypot(a,b)<=.12);}
    console.log(`${size} sites: ${size} unique colors; minimum OKLab distance ${minimum.toFixed(4)}`);
  }
});

test('sorted batches, title/order-independent keys, incremental sites and reload preserve colors',()=>{
  const storage=store(),domains=sites(24),first=api().create({storage,key:'colors'});first.prepare([...domains].reverse());const before=colors(first,domains);
  const other=api().create();other.prepare(domains);assert.deepEqual(colors(other,domains),before);
  first.prepare(sites(60));assert.deepEqual(colors(first,domains),before);
  assert.equal(first.color('SITE-000.EXAMPLE.'),before[0]);
  const reloaded=api().create({storage,key:'colors'});reloaded.prepare([...sites(60)].reverse());assert.deepEqual(colors(reloaded,sites(60)),colors(first,sites(60)));
  const second=api().create({storage,key:'unrelated-mode'});second.prepare(['separate.test']);assert.equal(JSON.parse(storage.getItem('colors')).entries.length,60);
});

test('candidate pool expands past the initial generated palette without recycling colors',()=>{
  const allocator=api().create(),domains=sites(1800);allocator.prepare(domains);assert.equal(new Set(colors(allocator,domains)).size,domains.length);
});

test('denied storage, quota errors and corrupted saved state do not stop assignment',()=>{
  for(const storage of [null,{getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){throw Error('denied');}},{getItem(){return '{';},setItem(){throw Error('quota');},removeItem(){}}]){
    const allocator=api().create({storage});assert.doesNotThrow(()=>allocator.prepare(sites(60)));assert.equal(new Set(colors(allocator,sites(60))).size,60);
    assert.doesNotThrow(()=>allocator.clear());assert.match(allocator.color('new.test'),/^#[0-9a-f]{6}$/);
  }
  const storage=store();storage.setItem('bad',JSON.stringify({version:999,entries:[['one.test','#ffffff']]}));
  const allocator=api().create({storage,key:'bad'});assert.notEqual(allocator.color('one.test'),'#ffffff');
});

test('saved colors are validated, duplicate colors repaired, and prototype-like names are safe',()=>{
  const storage=store(),valid=api().create();valid.prepare(['seed.test']);const seed=valid.color('seed.test');
  storage.setItem('colors',JSON.stringify({version:1,entries:[['valid.test',seed],['duplicate.test',seed],['invalid.test','url(https://example.invalid)'],['neon.test','#00ff00'],['','red'],null]}));
  const allocator=api().create({storage,key:'colors'});allocator.prepare(['valid.test','duplicate.test','invalid.test','neon.test','__proto__','constructor','toString']);
  assert.equal(allocator.color('valid.test'),seed);
  assert.equal(new Set(colors(allocator,['valid.test','duplicate.test','invalid.test','neon.test','__proto__','constructor','toString'])).size,7);
  assert.equal({}.polluted,undefined);
  assert.equal(allocator.color(null),'#708fa6');assert.equal(allocator.color('https://bad.test'),'#708fa6');
  allocator.clear();assert.equal(storage.getItem('colors'),null);
  allocator.prepare(['fresh.test']);assert.equal(JSON.parse(storage.getItem('colors')).entries.length,1);
});

test('another allocator can merge already saved new sites before assigning its own',()=>{
  const storage=store(),one=api().create({storage,key:'colors'}),two=api().create({storage,key:'colors'});
  one.prepare(['a.test']);two.prepare(['b.test']);assert.equal(two.color('a.test'),one.color('a.test'));
  one.prepare(['c.test']);assert.equal(one.color('b.test'),two.color('b.test'));assert.equal(JSON.parse(storage.getItem('colors')).entries.length,3);
});

test('another preview clearing the saved key cannot resurrect old site names',()=>{
  const storage=store(),first=api().create({storage,key:'colors'});first.prepare(['old-a.test','old-b.test']);
  const openPreview=api().create({storage,key:'colors'});first.clear();openPreview.prepare(['new.test']);
  assert.deepEqual(JSON.parse(storage.getItem('colors')).entries.map(([domain])=>domain),['new.test']);
  const failing=api().create({storage:{getItem(){return null;},setItem(){throw Error('quota');},removeItem(){}}});
  failing.prepare(['a.test']);const retained=failing.color('a.test');failing.prepare(['b.test']);assert.equal(failing.color('a.test'),retained,'an initially empty or unwritable store does not erase in-memory colors');
});
