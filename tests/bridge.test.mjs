import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decide,run,availableActions} from '../skills/jev-browser-use/bridge.mjs';
import {install} from '../scripts/install.mjs';

const actions = [{op:'click',index:1,description:'Click Settings'}];
const state = 'Browser tab: 1, Title: "Test", URL: "https://example.com/".\n0 AXWebArea Test\n1 button Settings';
const response = (choice='a0',confidence=0.9) => ({
  answers:{next:{type:'choice',choice,probabilities:{a0:choice==='a0'?1:0,DONE:choice==='DONE'?1:0,BLOCKED:0,WAIT:0}}},
  providerMetadata:{typesafe:{confidence:{next:confidence}}},
  usage:{inputTokens:100}
});

test('recognizes labelled checkbox names from live accessibility output',()=>{
  const snapshot=state+'\n10 checkbox (settable, integer) Description:  Weekly summary, Value: 0, ID: weekly';
  const found=availableActions(snapshot,[{op:'click',name:'Weekly summary'}]);
  assert.equal(found.length,1);
  assert.equal(found[0].index,10);
});

async function setup(t,reply=response()) {
  const dir=await mkdtemp(join(tmpdir(),'jev-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const envFile=join(dir,'credentials.env');
  await writeFile(envFile,'AI_GATEWAY_API_KEY=test-only-gateway-secret\nTYPESAFE_API_KEY=test-only-typesafe-secret\nOPENROUTER_API_KEY=test-only-router-secret\n');
  const requests=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    requests.push({url,options,body:JSON.parse(options.body)});
    return new Response(JSON.stringify(typeof reply==='function'?reply(requests.length):reply));
  });
  return {dir,envFile,requests,options:{provider:'vercel',envFile,goal:'Open Settings',state,actions}};
}

test('Vercel uses evaluation v4 and separate confidence metadata',async t=>{
  const {options,requests}=await setup(t);
  const result=await decide(options);
  assert.equal(result.choice,'a0');
  assert.equal(result.confidence,0.9);
  assert.equal(result.model,'typesafe-ai/jev');
  assert.equal(requests[0].url,'https://ai-gateway.vercel.sh/v4/ai/evaluation-model');
  assert.equal(requests[0].options.redirect,'error');
  assert.equal(requests[0].options.headers['ai-model-id'],'typesafe-ai/jev');
  assert.equal(requests[0].options.headers['ai-evaluation-model-specification-version'],'4');
  assert.equal(requests[0].options.headers.Authorization,'Bearer test-only-gateway-secret');
  assert.equal(requests[0].body.model,undefined);
  assert.equal(requests[0].body.providerOptions.gateway.zeroDataRetention,true);
  assert.equal(requests[0].body.state.goal,'Open Settings');
  assert.ok(!requests[0].options.body.includes('test-only-gateway-secret'));
});

for(const provider of ['typesafe','openrouter']) test(`${provider} contract stays compatible`,async t=>{
  const raw=response();
  raw.answers.next.confidence=0.9;
  raw.model=provider==='typesafe'?'jev-1.13':'typesafe/jev-1.13';
  delete raw.providerMetadata;
  const {options,requests}=await setup(t,raw);
  const result=await decide({...options,provider});
  assert.equal(result.model,raw.model);
  assert.equal(requests[0].body.model,provider==='typesafe'?'jev-latest':'~typesafe/jev-latest');
  assert.equal(requests[0].options.headers['ai-model-id'],undefined);
  assert.equal(requests[0].body.providerOptions,undefined);
});

for(const [name,mutate] of [
  ['missing confidence',r=>delete r.providerMetadata.typesafe.confidence.next],
  ['invalid confidence',r=>r.providerMetadata.typesafe.confidence.next=1.1],
  ['invented action',r=>r.answers.next.choice='a999'],
  ['missing probabilities',r=>delete r.answers.next.probabilities],
  ['wrong probability total',r=>r.answers.next.probabilities.a0=0.5],
  ['non-maximum choice',r=>{r.answers.next.probabilities.a0=0.1;r.answers.next.probabilities.DONE=0.9;}]
]) test(`rejects ${name}`,async t=>{
  const raw=response(); mutate(raw);
  const {options}=await setup(t,raw);
  await assert.rejects(decide(options),/Invalid vercel decision schema/);
});

test('rejects a mismatched model and credential in input before transmission',async t=>{
  const {options,requests}=await setup(t);
  await assert.rejects(decide({...options,model:'jev-latest'}),/Invalid Jev model/);
  await assert.rejects(decide({...options,goal:'test-only-gateway-secret'}),/Credential detected/);
  assert.equal(requests.length,0);
});

test('does not expose upstream errors or retry rejected credentials',async t=>{
  const {options}=await setup(t);
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('private upstream details',{status:401});});
  const tab={getAXState:async()=>state};
  const result=await run(tab,{...options,controls:[{op:'click',name:'Settings'}],allowedOrigins:['https://example.com']});
  assert.equal(result.status,'decision_error');
  assert.equal(result.error,'vercel HTTP 401');
  assert.equal(calls,1);
});

test('stale and unauthorized pages cannot execute a proposed click',async t=>{
  const {options,requests}=await setup(t);
  let reads=0,clicks=0;
  const tab={getAXState:async()=>++reads===1?state:state+'\n2 button Other',click:async()=>clicks++};
  const task={...options,controls:[{op:'click',name:'Settings'}],allowedOrigins:['https://example.com'],maxSteps:1};
  const result=await run(tab,task);
  assert.equal(clicks,0);
  assert.equal(result.history[0].reason,'stale_state');
  await assert.rejects(run({getAXState:async()=>state.replace('https://example.com','https://outside.test')},task),/authorized origins/);
  assert.equal(requests.length,1);
});

for(const control of [{op:'press',key:'Escape'},{op:'scroll',direction:'down'}]) test(`${control.op} matches the current browser key signature`,async t=>{
  const {options}=await setup(t,n=>response(n===1?'a0':'DONE'));
  const calls=[];
  const tab={getAXState:async()=>state,pressKey:async(...args)=>calls.push(args)};
  const result=await run(tab,{...options,controls:[control],allowedOrigins:['https://example.com']});
  assert.deepEqual(calls,[[null,control.op==='press'?'Escape':'PageDown']]);
  assert.equal(result.status,'needs_verification');
});

test('installer accepts Vercel and preserves existing configuration',async t=>{
  const {dir,envFile}=await setup(t);
  const config={provider:'vercel',model:'typesafe-ai/jev',envFile};
  const installed=await install({home:dir,config});
  assert.deepEqual(JSON.parse(await readFile(installed.configPath,'utf8')),config);
  assert.equal((await stat(installed.configPath)).mode&0o777,0o600);
  await install({home:dir,config:{provider:'typesafe',model:'jev-latest',envFile}});
  assert.deepEqual(JSON.parse(await readFile(installed.configPath,'utf8')),config);
  assert.ok((await readFile(join(installed.target,'bridge.mjs'),'utf8')).includes('evaluation-model'));
});
