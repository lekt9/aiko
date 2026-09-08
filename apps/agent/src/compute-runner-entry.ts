import { Database } from "bun:sqlite";
import { sandboxJobJournal } from "./sandbox-job-journal.ts";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import {
  createPythonSandboxRuntime,
  type PythonRuntimeOptions,
} from "./sandbox-python.ts";
import {
  runSandboxJob,
  type SandboxJobBinding,
  type SandboxJobJournal,
} from "./sandbox-job-runner.ts";
import {
  sandboxDigest,
  type SandboxDigest,
  type SandboxJob,
} from "./sandbox-job.ts";

/** Trusted bundle calls this entry with createPythonSandboxRuntime's execute
 * binding. No candidate can choose the runtime or enable ambient Python. */
export async function computeRunnerEntry(
  options: {
    environmentDigest: SandboxDigest;
    runtimeLockDigest: SandboxDigest;
    binding: (
      owner: string,
      journal: SandboxJobJournal,
    ) => Promise<SandboxJobBinding>;
  },
  args = process.argv.slice(2),
) {
  const [mode, input, output] = args;
  const allowed = (path: string | undefined) =>
    !!path &&
    /^\/tmp\/aiko-(?:compute|job)-[a-f0-9]{64}\.(?:environment|input|receipt)\.json$/.test(
      path,
    );
  const atomic = async (path: string, value: unknown) => {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  };
  if (mode === "environment" && allowed(input)) {
    // Runtime constructor must independently verify toolchain and isolation pins.
    const probe = await options.binding("runtime-probe", {
      claim: async () => {
        throw Error("Probe cannot execute");
      },
      read: async () => undefined,
      settle: async () => {
        throw Error("Probe cannot execute");
      },
    });
    if (probe.environmentDigest !== options.environmentDigest)
      throw Error("Runtime environment mismatch");
    await atomic(input!, {
      environmentDigest: options.environmentDigest,
      runtimeLockDigest: options.runtimeLockDigest,
    });
    return;
  }
  if (mode !== "job" || !allowed(input) || !allowed(output))
    throw Error("Invalid trusted compute entry arguments");
  const job = JSON.parse(await readFile(input!, "utf8")) as SandboxJob;
  if (
    job.artifact.kind !== "python" ||
    job.artifact.runtimeLockDigest !== options.runtimeLockDigest
  )
    throw Error("Python runtime lock mismatch");
  const root = `/tmp/aiko-compute-journal/${(await sandboxDigest(job.owner)).slice(7)}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new Database(`${root}/jobs.sqlite`);
  try {
    const journal = await sandboxJobJournal(db, `${root}/receipt.key`);
    const binding = await options.binding(job.owner, journal);
    if (binding.environmentDigest !== options.environmentDigest)
      throw Error("Runtime environment mismatch");
    const receipt = await runSandboxJob(job, binding);
    await atomic(output!, receipt);
  } finally {
    db.close();
  }
}

/** Independent control-plane pin for the exact uploaded bundle and native Bun ABI. */
export const computeRunnerEnvironment = (
  runnerBundle: string,
  runtimeLockDigest: SandboxDigest,
  bunVersion: string,
) =>
  sandboxDigest({
    abi: "unlock-compute-runner/1",
    runnerBundle,
    runtimeLockDigest,
    bunVersion,
  });

/** Bundle this call with fixed host runtime options; does not install dependencies.
 * The environment attests the actual executing bundle, not a configured constant. */
export async function pythonComputeRunner(
  options: { runtime?: PythonRuntimeOptions; runtimeLockDigest: SandboxDigest },
  args = process.argv.slice(2),
) {
  let python: Awaited<ReturnType<typeof createPythonSandboxRuntime>>;
  try { python = await createPythonSandboxRuntime(options.runtime); }
  catch (error) {
    // A probe cannot execute candidate code. Missing bytes are distinct from
    // uncertain execution, isolation denial, resource exhaustion or a timeout.
    if (args[0] === "environment" && /^\/tmp\/aiko-compute-[a-f0-9]{64}\.environment\.json$/.test(args[1] ?? "") && (error as any)?.code === "ENOENT") {
      await writeFile(args[1]!, JSON.stringify({ready:false,reason:"runtime-missing",runtimeLockDigest:options.runtimeLockDigest}), {mode:0o600});
      return;
    }
    throw error;
  }
  try {
  if (python.lockDigest !== options.runtimeLockDigest) {
    if (args[0] === "environment" && /^\/tmp\/aiko-compute-[a-f0-9]{64}\.environment\.json$/.test(args[1] ?? "")) {
      await writeFile(args[1]!, JSON.stringify({ready:false,reason:"runtime-lock-mismatch",runtimeLockDigest:options.runtimeLockDigest}), {mode:0o600});
      return;
    }
    throw Error("Configured Python runtime lock mismatch");
  }
  await python.check();
  const environmentDigest = await computeRunnerEnvironment(
    await readFile(process.argv[1]!, "utf8"),
    python.lockDigest,
    Bun.version,
  );
  return await computeRunnerEntry(
    {
      ...options,
      environmentDigest,
      binding: async (owner, journal) => ({
        owner,
        journal,
        environmentDigest,
        python,
      }),
    },
    args,
  );
  } finally { python.dispose(); }
}

/** Only invoked by the uploaded trusted entry; recipe identity is retained by
 * the host before dispatch. No package resolution accepts candidate input. */
export async function provisionComputeRuntime(recipePath:string,reportPath:string){
  if(!/^\/tmp\/aiko-setup-[a-f0-9]{64}\.recipe\.json$/.test(recipePath)||!/^\/tmp\/aiko-setup-[a-f0-9]{64}\.report\.json$/.test(reportPath))throw Error("Invalid setup paths");
  const recipe=JSON.parse(await readFile(recipePath,"utf8")) as import("./compute-harness.ts").TrustedComputeRecipe;
  const recipeDigest=await sandboxDigest(recipe),root=`/opt/aiko-compute-${(await sandboxDigest([recipeDigest,reportPath])).slice(7)}`,cgroupRoot=`/sys/fs/cgroup/aiko-compute-${(await sandboxDigest([recipeDigest,reportPath])).slice(7)}`;
  const setup=String.raw`import hashlib,json,os,pathlib,re,shlex,shutil,subprocess,sys,urllib.request,zipfile
r=json.load(sys.stdin); root=pathlib.Path(r['root']); recipe=r['recipe']
def sha(path):
 with open(path,'rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
for name,pin in recipe['native'].items():
 if sha(pin['path'])!=pin['sha256']:raise RuntimeError('Native runtime pin mismatch: '+name)
subprocess.run(['sudo','install','-d','-m','0700','-o',str(os.getuid()),'-g',str(os.getgid()),str(root)],check=True)
def phase(value):(root/'setup-phase').write_text(value)
phase('isolation-package')
def download(url,path,pin):
 if path.exists():
  if path.stat().st_size==pin['bytes'] and sha(path)==pin['sha256']:return
  raise RuntimeError('Retained dependency pin mismatch')
 temp=path.with_suffix(path.suffix+'.partial')
 with urllib.request.urlopen(url,timeout=60) as response,open(temp,'wb') as output:
  total=0
  while True:
   data=response.read(1048576)
   if not data:break
   total+=len(data)
   if total>pin['bytes']:raise RuntimeError('Download exceeds pinned bytes')
   output.write(data)
 if temp.stat().st_size!=pin['bytes'] or sha(temp)!=pin['sha256']:raise RuntimeError('Download integrity mismatch')
 temp.rename(path)
download(recipe['bubblewrap']['url'],root/'bubblewrap.deb',recipe['bubblewrap'])
subprocess.run(['dpkg-deb','-x',str(root/'bubblewrap.deb'),str(root/'isolation')],check=True)
phase('python-dependencies')
requirements=root/'requirements.lock';requirements.write_text(recipe['requirements'])
wheels=root/'wheels';wheels.mkdir(exist_ok=True)
subprocess.run(['/usr/local/bin/python3','-m','pip','--python',recipe['native']['python']['path'],'download','--no-cache-dir','--require-hashes','--only-binary=:all:','--dest',str(wheels),'-r',str(requirements)],check=True)
allowed=set(re.findall(r'--hash=sha256:([a-f0-9]{64})',recipe['requirements']))
packages=root/'packages';packages.mkdir(exist_ok=True)
for wheel in wheels.glob('*.whl'):
 if sha(wheel) not in allowed:raise RuntimeError('Unpinned wheel')
 with zipfile.ZipFile(wheel) as archive:
  for item in archive.infolist():
   p=pathlib.PurePosixPath(item.filename)
   if p.is_absolute() or '..' in p.parts or (item.external_attr>>16)&0o170000==0o120000:raise RuntimeError('Unsafe wheel path')
  archive.extractall(packages)
# Archives have been independently hash checked and extracted. They are not
# execution inputs; keep the exact lock and installed bytes, not a second cache.
shutil.rmtree(wheels)
phase('model-files')
for directory,model in {'whisper-tiny.en':recipe['model'],**recipe.get('models',{})}.items():
 if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',directory) or directory in ('.','..'):raise RuntimeError('Invalid model directory')
 models=root/'models'/directory;models.mkdir(parents=True,exist_ok=True)
 for name,pin in model['files'].items():
  if not re.fullmatch(r'[A-Za-z0-9_.-]+',name) or name in ('.','..'):raise RuntimeError('Invalid model path')
  download('https://huggingface.co/'+model['repository']+'/resolve/'+model['revision']+'/'+name,models/name,pin)
# The VM is dedicated to this owner. Delegate an empty subtree, not init.scope.
phase('cgroup-delegation')
delegate="import pathlib,os,sys,pwd; b=pathlib.Path('/sys/fs/cgroup'); (b/'cgroup.subtree_control').write_text('+cpu +memory +pids'); p=pathlib.Path(sys.argv[1]); p.mkdir(exist_ok=True); (p/'cgroup.subtree_control').write_text('+cpu +memory +pids'); [(os.chown(str(q),int(sys.argv[2]),int(sys.argv[3]))) for q in [b/'cgroup.procs',p,p/'cgroup.procs',p/'cgroup.subtree_control']]; policy=pathlib.Path('/etc/sudoers.d/aiko-compute-fds'); policy.write_text('Defaults:'+pwd.getpwuid(int(sys.argv[2])).pw_name+' closefrom_override'+chr(10)); policy.chmod(0o440)"
subprocess.run(['sudo',recipe['native']['python']['path'],'-c',delegate,r['cgroupRoot'],str(os.getuid()),str(os.getgid())],check=True)
phase('python-snapshot')
import shutil,sysconfig
pythonhome=root/'python'
(pythonhome/'bin').mkdir(parents=True,exist_ok=True)
shutil.copy2(recipe['native']['python']['path'],pythonhome/'bin'/'python3.13')
shutil.copytree(sysconfig.get_path('stdlib'),pythonhome/'lib'/'python3.13',symlinks=False,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','site-packages','dist-packages'))
phase('isolation-probe')
bwrap=root/'isolation/usr/bin/bwrap'
launcher=root/'bwrap-launch'
# This launcher is deployment-owned. No candidate chooses its path or arguments.
script=f"""#!{recipe['native']['python']['path']}
import fcntl,hashlib,os,struct,sys
binary={str(bwrap)!r}
with open(binary,'rb') as source:
 if hashlib.file_digest(source,'sha256').hexdigest()!={sha(bwrap)!r}:raise RuntimeError('Isolation binary changed')
args=sys.argv[1:]
if args==['--version']:os.execv(binary,[binary,'--version'])
if len(args)>=2 and args[0]=='--args':
 fd=int(args[1]);os.lseek(fd,0,0);data=b''
 while True:
  part=os.read(fd,65536)
  if not part:break
  data+=part
  if len(data)>4194304:raise RuntimeError('Trusted argument budget exceeded')
 if not data.endswith(bytes([0])):raise RuntimeError('Invalid sealed arguments')
 args=data[:-1].decode().split(chr(0))+args[2:]
if not args or args[0]!='--unshare-all':raise RuntimeError('Unsupported trusted launcher arguments')
args=[a for a in args[1:] if a not in ['--unshare-user','--disable-userns','--assert-userns-disabled']]
if '/runtime/bin/python' in args:
 i=args.index('/runtime/bin/python')
 # Flags precede bwrap's command delimiter; the dropper is the first sandbox process.
 marker=i-1 if i>0 and args[i-1]=='--' else i
 args[marker:marker]=['--cap-add','CAP_SETUID','--cap-add','CAP_SETGID','--cap-add','CAP_DAC_OVERRIDE','--chmod','0777','/work','--chmod','0777','/work/tmp']
 i=args.index('/runtime/bin/python')
 args[i:i]=['/tools/droppriv','--reuid={os.getuid()}','--regid={os.getgid()}','--clear-groups','--no-new-privs']
elif not args or args[-1]!='/usr/bin/true':raise RuntimeError('Unsupported trusted runner command')
# Kernel-enforced namespace denial replaces unavailable user-namespace sysctls.
# x86_64 is fixed by the native recipe; reject compat/x32 syscall bypasses.
policy=[(0x20,0,0,4),(0x15,1,0,0xc000003e),(0x06,0,0,0x80000000),(0x20,0,0,0),(0x45,0,1,0x40000000),(0x06,0,0,0x80000000),(0x15,0,1,272),(0x06,0,0,0x50001),(0x15,0,1,308),(0x06,0,0,0x50001),(0x15,0,1,435),(0x06,0,0,0x50026),(0x15,0,3,56),(0x20,0,0,16),(0x45,0,1,0x10000000),(0x06,0,0,0x50001),(0x06,0,0,0x7fff0000)]
filterfd=os.memfd_create('aiko-namespace-filter',os.MFD_ALLOW_SEALING)
os.write(filterfd,b''.join(struct.pack('HBBI',*instruction) for instruction in policy));os.lseek(filterfd,0,0)
fcntl.fcntl(filterfd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SEAL);os.set_inheritable(filterfd,True)
args=['--unshare-pid','--unshare-ipc','--unshare-uts','--unshare-net','--seccomp',str(filterfd),'--cap-drop','ALL']+args
fd=os.memfd_create('aiko-provider-args',os.MFD_ALLOW_SEALING)
os.write(fd,(chr(0).join(args)+chr(0)).encode());os.lseek(fd,0,0)
fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SEAL)
os.set_inheritable(fd,True)
maximum=fd
for name in os.listdir('/proc/self/fd'):
 try:
  current=int(name);os.fstat(current);maximum=max(maximum,current)
 except OSError:pass
os.execv('/usr/bin/sudo',['sudo','-n','-C',str(maximum+1),'--',binary]+args)
"""
launcher.write_text(script);launcher.chmod(0o700)
subprocess.run([str(launcher),'--unshare-all','--dir','/tmp','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','/usr/bin/true'],check=True)
print('Trusted compute dependencies verified')
`;
  const child=Bun.spawn([recipe.native.python.path,"-c",setup],{stdin:"pipe",stdout:"inherit",stderr:"inherit"});
  child.stdin.write(JSON.stringify({recipe,root,cgroupRoot}));child.stdin.end();
  const runnerBundle=await readFile(process.argv[1]!,"utf8");
  const failed=async(reason:string)=>{await writeFile(reportPath,JSON.stringify({version:1,ready:false,recipeDigest,runnerDigest:await sandboxDigest(runnerBundle),reason}),{mode:0o600});};
  if(await child.exited!==0){let reason="native-runtime-pin";try{reason=await readFile(`${root}/setup-phase`,"utf8");}catch{}await failed(reason);throw Error("Trusted compute dependency setup failed: "+reason);}
  const runtime={python:`${root}/python/bin/python3.13`,tools:{ffmpeg:recipe.native.ffmpeg.path,ffprobe:recipe.native.ffprobe.path,droppriv:recipe.native.droppriv.path},bubblewrap:`${root}/bwrap-launch`,packages:`${root}/packages`,models:`${root}/models`,cgroupRoot};
  const memory = async () => Object.fromEntries(await Promise.all(["memory.max", "memory.current", "memory.peak", "memory.events"].map(async name => [name, (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim()])));
  const memoryBefore = await memory(), captureBegan = Date.now();
  await writeFile(`${root}/setup-phase`, "runtime-capture");
  let python:Awaited<ReturnType<typeof createPythonSandboxRuntime>>|undefined;
  try {
  try{python=await createPythonSandboxRuntime(runtime);await python.check();}catch(error){await failed("runtime-attestation");throw error;}
  const report={version:1,ready:true,capture:{...python.capture,wallMs:Date.now()-captureBegan,memoryBefore,memoryAfter:await memory()},bunVersion:Bun.version,recipeDigest,runnerDigest:await sandboxDigest(runnerBundle),runtimeLockDigest:python.lockDigest,lock:python.lock,runtime,cgroupRoot,environmentDigest:await computeRunnerEnvironment(runnerBundle,python.lockDigest,Bun.version)};
  const temporary=`${reportPath}.tmp`;await writeFile(temporary,JSON.stringify(report),{mode:0o600});await rename(temporary,reportPath);
  await writeFile(`${root}/setup-phase`, "ready");
  } finally { python?.dispose(); }
}
