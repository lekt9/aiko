import {test,expect} from 'bun:test';
import {existsSync} from 'node:fs';
const modelRoot=process.env.MEDIA_HARNESS_MODELS??'/tmp/unlock-media-multilingual-models';
const modelsReady=existsSync(modelRoot+'/whisper-tiny/config.json');
import {normalizeTelegramUpdate,serializeTelegramInbound} from '../src/telegram-normalize.ts';
import {mediaIngressApi} from '../src/media-host.ts';
test('private Telegram locale survives normalized durable ingress as a bounded language hint',()=>{
 const update={update_id:51,message:{message_id:51,date:Math.floor(Date.now()/1000),from:{id:123,is_bot:false,language_code:'es-ES'},chat:{id:123,type:'private'},voice:{file_id:'fixture_audio',duration:1}}};
 const first=normalizeTelegramUpdate(update,{allowedUsers:new Set(['123'])});expect(first.inbound?.language).toBe('es');
 const replay=normalizeTelegramUpdate(JSON.parse(serializeTelegramInbound(first.inbound!)),{allowedUsers:new Set(['123'])});expect(replay.inbound?.language).toBe('es');
 const wrong=normalizeTelegramUpdate({...update,message:{...update.message,from:{...update.message.from,language_code:'../../provider'}}},{allowedUsers:new Set(['123'])});expect(wrong.inbound?.language).toBeUndefined();
});
test('missing isolated runtime never admits media or publishes a model variant',async()=>{
 for(const path of ['/api/media','/api/media/catalog'])expect((await mediaIngressApi(new Request('http://fixture'+path,{method:'POST',body:'{}'}),'123',undefined,()=>{throw Error('No wake');})).status).toBe(503);
});

test.skipIf(!modelsReady)('published multilingual model requires the exact retained file hashes',async()=>{
 const {verifyMediaModelDirectory}=await import('../src/harness-media-lock.ts');
 const pin=(await import('../assets/media-multilingual-model.lock.json')).default.model;
 const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');
 const root=modelRoot;
 await verifyMediaModelDirectory(root+'/whisper-tiny',pin);
 const dir=await mkdtemp('/tmp/model-hash-denial-');try{const bytes=await readFile(root+'/whisper-tiny/config.json');bytes[0]=bytes[0]!^1;await writeFile(dir+'/config.json',bytes);await expect(verifyMediaModelDirectory(dir,pin)).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
});
