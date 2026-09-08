import {readFile} from "node:fs/promises";
import {provisionComputeRuntime,pythonComputeRunner} from "./compute-runner-entry.ts";

{
  const args=process.argv.slice(2);
  if(args[0]==="setup")await provisionComputeRuntime(args[1]!,args[2]!);
  else if(args[0]==="--config"&&/^\/tmp\/aiko-compute-[a-f0-9]{64}\.config\.json$/.test(args[1]!))await pythonComputeRunner(JSON.parse(await readFile(args[1]!,"utf8")),args.slice(2));
  else throw Error("Trusted compute entry configuration required");
}
