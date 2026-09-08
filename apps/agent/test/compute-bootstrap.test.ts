import {expect,test} from "bun:test";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import bootstrap from "../assets/bootstrap.sh" with {type:"text"};

test("actual bootstrap compute mode skips embedding installation while default browser mode preserves it",async()=>{
 const root=await mkdtemp('/tmp/compute-bootstrap-');
 try {
  await mkdir(`${root}/.bun/bin`,{recursive:true});
  await writeFile(`${root}/.bun/bin/bun`,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${root}/calls'\nexit 0\n`,{mode:0o700});
  await writeFile(`${root}/tool`,"#!/bin/sh\nexit 0\n",{mode:0o700});
  const script=bootstrap.replaceAll('/home/daytona',root).replaceAll('/usr/bin/chromium',`${root}/tool`).replaceAll('/usr/bin/espeak-ng',`${root}/tool`).replaceAll('/usr/bin/ffmpeg',`${root}/tool`).replaceAll('/usr/bin/pdftotext',`${root}/tool`);
  await writeFile(`${root}/bootstrap.sh`,script);
  for(const compute of [true,false]) {
   await writeFile(`${root}/calls`,'');
   const child=Bun.spawn(['bash',`${root}/bootstrap.sh`,...(compute?['--compute']:[])],{stdout:'ignore',stderr:'pipe'});
   expect(await child.exited).toBe(0);
   const calls=await readFile(`${root}/calls`,'utf8');
   expect(calls.includes('add --exact @huggingface/transformers@3.8.1')).toBe(!compute);
   expect(calls.includes('--version')).toBe(true);
  }
  const invalid=Bun.spawn(['bash',`${root}/bootstrap.sh`,'--unknown'],{stdout:'ignore',stderr:'ignore'});
  expect(await invalid.exited).toBe(2);
 }finally{await rm(root,{recursive:true,force:true});}
});
