/** Original geometric fixtures, CC0-1.0. Oracle is authored geometry, not CV output.
 * Regeneration is explicit; tests only consume pinned bytes/manifest. */
import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { mediaCommand } from "../media-fixtures.ts";
const root = new URL("./",import.meta.url);
const oracle = {
  conflict:{occupancy:[[false,true],[true,true],[false,false]],order:["pedestrian","vehicle"],answer:"observed_conflict",conflictInterval:[1,3]},
  safe:{occupancy:[[true,false],[false,true],[false,false]],order:["vehicle","pedestrian"],answer:"not_observed",conflictInterval:null},
  short:{occupancy:[[true,false],[false,true],[false,false]],order:["vehicle","pedestrian"],answer:"not_observed",conflictInterval:[1.1,1.2]},
};
const entries=[];
for(const [name,expected] of Object.entries(oracle)) {
  const frames=[];
  for(let frame=0;frame<40;frame++) {
    const image=Buffer.alloc(320*240*3,240);
    const rect=(x:number,y:number,w:number,h:number,rgb:number[])=>{for(let j=Math.max(0,y);j<Math.min(240,y+h);j++)for(let i=Math.max(0,x);i<Math.min(320,x+w);i++)for(let c=0;c<3;c++)image[(j*320+i)*3+c]=rgb[c]!;};
    rect(0,40,320,160,[45,45,45]);
    for(let y=40;y<200;y+=20)rect(140,y,40,8,[245,245,245]);
    let car=260,ped=220;
    if(name==="conflict") {if(frame<10){car=60;ped=100;}else if(frame<30){car=160;ped=100;}}
    else {if(frame<10){car=160;ped=20;}else if(frame<30){car=260;ped=100;} if(name==="short"&&frame===11){car=160;ped=100;}}
    // Vehicle: cabin/body/wheels. Pedestrian: head/body/two separated legs.
    rect(car-24,105,48,20,[40,80,220]);rect(car-12,97,24,8,[40,80,220]);
    rect(car-18,125,9,5,[15,15,15]);rect(car+9,125,9,5,[15,15,15]);
    rect(155,ped-14,10,10,[210,40,150]);rect(154,ped-4,12,14,[210,40,150]);
    rect(153,ped+10,5,10,[210,40,150]);rect(162,ped+10,5,10,[210,40,150]);
    frames.push(image);
  }
  const file=`crossing-${name}.mp4`;
  await mediaCommand(["/usr/bin/ffmpeg","-nostdin","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s","320x240","-r","10","-i","pipe:0","-threads","1","-c:v","mpeg4","-q:v","2","-fflags","+bitexact","-flags:v","+bitexact","-y",new URL(file,root).pathname],Buffer.concat(frames));
  const bytes=await readFile(new URL(file,root));entries.push({file,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,durationSeconds:4,fps:10,timestamps:[0.4,2,3.6],expected});
}
await writeFile(new URL("manifest.json",root),JSON.stringify({version:1,license:"CC0-1.0",provenance:"Original programmatically authored schematic road-crossing media; no imported audio, images, fonts or models.",generatorSha256:createHash("sha256").update(await readFile(new URL("generate.ts",root))).digest("hex"),rubric:"Exact sampled vehicle/pedestrian occupancy, first observed order, conflict answer and actual PTS. Sparse absence never proves safety. Fixed before candidate execution.",fixtures:entries},null,2)+"\n");
