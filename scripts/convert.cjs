const fs=require('fs'),path=require('path'),crypto=require('crypto'),vm=require('vm'),XLSX=require('xlsx');
const ROOT=path.resolve(__dirname,'..'),DATA=path.join(ROOT,'data'),JSON_ROOT=path.join(ROOT,'data-json');
const CHECK=process.argv.includes('--check'),SCHEMA_VERSION=1;
const MAP_KEYS=['summaries','records','itemCountDaily','lineHumanDaily','lineAvgFromSheets','stoplineDaily','changeoverDaily','changeoverCountDaily'];
const slash=p=>p.split(path.sep).join('/');
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const readJson=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
const writeJson=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};

function scanFiles(dir,re,base=dir){
  if(!fs.existsSync(dir))return[];
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
    if(e.name.startsWith('.')||e.name.startsWith('~$'))return[];
    const full=path.join(dir,e.name);
    if(e.isDirectory())return scanFiles(full,re,base);
    return re.test(e.name)?[slash(path.relative(base,full))]:[];
  }).sort((a,b)=>a.localeCompare(b,'zh-Hant',{numeric:true}));
}
function reportSpan(rel){
  const name=path.posix.basename(rel).normalize('NFKC');
  const m=name.match(/(?:^|[^0-9])(\d{3})[.\-_/](\d{1,2})[.\-_/](\d{1,2})\s*[-~～至]\s*(\d{1,2})/);
  return m?{monthKey:`${Number(m[1])+1911}-${String(Number(m[2])).padStart(2,'0')}`,start:Number(m[3]),end:Number(m[4])}:null;
}
function chooseSourceFiles(all){
  const excluded=new Set(),chosen=new Map();
  for(const rel of all){
    const span=reportSpan(rel);if(!span)continue;
    const key=`${span.monthKey}|${span.start}`,old=chosen.get(key);
    if(!old||span.end>old.span.end||(span.end===old.span.end&&rel>old.rel)){if(old)excluded.add(old.rel);chosen.set(key,{rel,span});}else excluded.add(rel);
  }
  return{files:all.filter(x=>!excluded.has(x)),excluded:[...excluded]};
}
function loadWebsiteParser(){
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  const blocks=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
  const full=blocks.find(s=>s.includes('async function parseWorkbookArrayBuffer'));
  if(!full)throw new Error('index.html 找不到人時性解析函式');
  const source=full.split('(async function init(){')[0];
  const stub=new Proxy(function(){},{get:(_t,k)=>{
    if(k==='style'||k==='dataset')return{};if(k==='options')return[];
    if(k==='classList')return{add(){},remove(){},toggle(){},contains(){return false;}};return stub;
  },apply:()=>stub});
  const document={getElementById(){return stub;},querySelector(){return stub;},querySelectorAll(){return[];},createElement(){return stub;},addEventListener(){},head:stub,body:stub,documentElement:stub};
  const sandbox={XLSX,console,document,navigator:{},location:{host:'',href:'http://localhost/',pathname:'/',protocol:'http:',search:''},setTimeout,clearTimeout,setInterval,clearInterval,AbortController,DOMException,URL,URLSearchParams,Blob,Map,Set,Date,Math,Intl,requestAnimationFrame(){},requestIdleCallback(fn){fn();},localStorage:{getItem(){return null;},setItem(){},removeItem(){}},fetch:async()=>{throw new Error('converter 不執行網路請求');},alert(){},confirm(){return false;}};
  sandbox.window=sandbox;sandbox.window.addEventListener=()=>{};sandbox.window.removeEventListener=()=>{};
  vm.createContext(sandbox);vm.runInContext(source,sandbox,{filename:'index.html',timeout:20000});
  vm.runInContext(`globalThis.__dashboardParser={async parse(buf,filename){for(const key of ${JSON.stringify(MAP_KEYS)})state[key]=new Map();state.recordList=[];state.firstSeenProd=new Map();state.loadedFiles=[];await parseWorkbookArrayBuffer(buf,filename);const payload={recordList:state.recordList};for(const key of ${JSON.stringify(MAP_KEYS)})payload[key]=Array.from(state[key].entries());return payload;}}`,sandbox);
  return{api:sandbox.__dashboardParser,parserHash:hash(`${SCHEMA_VERSION}\n${source}`),sandbox};
}
function validatePayload(p,rel){
  if(!p||!Array.isArray(p.recordList))throw new Error(`${rel}: JSON 缺少 recordList`);
  for(const k of MAP_KEYS)if(!Array.isArray(p[k]))throw new Error(`${rel}: JSON 缺少 ${k}`);
}
async function main(){
  const{api,parserHash,sandbox}=loadWebsiteParser();
  const{files,excluded}=chooseSourceFiles(scanFiles(DATA,/\.xlsx$/i));
  if(excluded.length)console.log(`略過 ${excluded.length} 份已有較完整版本的舊檔：${excluded.join('、')}`);
  const oldManifest=readJson(path.join(DATA,'json-manifest.json'))||{},entries={};let converted=0,reused=0;
  for(const rel of files){
    const sourceFile=path.join(DATA,...rel.split('/')),sourceSha256=hash(fs.readFileSync(sourceFile));
    const jsonRel=slash(path.join('data-json',rel.replace(/\.xlsx$/i,'.json'))),jsonFile=path.join(ROOT,...jsonRel.split('/')),old=oldManifest.files&&oldManifest.files[rel];
    if(old&&old.sourceSha256===sourceSha256&&old.parserHash===parserHash&&old.json===jsonRel&&fs.existsSync(jsonFile)){validatePayload(readJson(jsonFile),rel);entries[rel]={...old,jsonBytes:fs.statSync(jsonFile).size};reused++;continue;}
    if(CHECK)throw new Error(`${rel}: JSON 尚未更新，請執行 npm run convert:data`);
    sandbox.__input=new Uint8Array(fs.readFileSync(sourceFile));const payload=await api.parse(sandbox.__input,rel);delete sandbox.__input;
    Object.assign(payload,{schemaVersion:SCHEMA_VERSION,source:rel,sourceSha256,parserHash});validatePayload(payload,rel);writeJson(jsonFile,payload);
    entries[rel]={json:jsonRel,sourceSha256,parserHash,jsonBytes:fs.statSync(jsonFile).size};converted++;console.log(`轉換 ${rel}`);
  }
  const expected=new Set(Object.values(entries).map(e=>e.json.replace(/^data-json\//,'')));
  const orphan=scanFiles(JSON_ROOT,/\.json$/i).filter(rel=>!expected.has(rel));
  const stale=Object.keys(oldManifest.files||{}).filter(rel=>!entries[rel]).map(rel=>oldManifest.files[rel]&&oldManifest.files[rel].json).filter(rel=>typeof rel==='string'&&rel.startsWith('data-json/')).map(rel=>rel.replace(/^data-json\//,''));
  const cleanup=[...new Set([...orphan,...stale])],fileList={files};
  if(CHECK){
    if(JSON.stringify(readJson(path.join(DATA,'manifest.json')))!==JSON.stringify(fileList))throw new Error('data/manifest.json 與資料夾內容不同步');
    if(JSON.stringify(oldManifest.files||{})!==JSON.stringify(entries))throw new Error('data/json-manifest.json 與 JSON 檔不同步');
    if(cleanup.length)throw new Error(`data-json 含 ${cleanup.length} 份無來源的舊 JSON`);
  }else{
    writeJson(path.join(DATA,'manifest.json'),fileList);writeJson(path.join(DATA,'json-manifest.json'),{schemaVersion:SCHEMA_VERSION,parserHash,generatedAt:new Date().toISOString(),files:entries});
    if(cleanup.length)console.log(`清理 ${cleanup.length} 份無來源 JSON`);
    for(const rel of cleanup){const target=path.join(JSON_ROOT,...rel.split('/'));if(fs.existsSync(target))fs.unlinkSync(target);}
  }
  console.log(`${CHECK?'檢查完成':'轉換完成'}：${files.length} 份（新轉 ${converted}、沿用 ${reused}）`);
}
main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
