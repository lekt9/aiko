import { validateSiteHarnessArtifact, type ValueProducer } from "@unbrowse/browser-harness/harness-artifact";
import { sandboxDigest, verifySandboxReceipt, type SandboxJob } from "./sandbox-job.ts";
import type { RegistrySandboxTransport } from "./registry-defaults.ts";
import { webhookTarget, type WebhookTransport } from "./webhook-adapter.ts";

/** Worker-compatible delivery through the existing owner-scoped network sandbox.
 * The runner's sendObservedHttp resolves/pins public DNS and keeps redirects
 * manual. A one-request budget prevents the harness following even a same-origin
 * redirect. Only the signed proof enters private job input, never its key. */
export function createSandboxWebhookTransport(owner: string, transport: RegistrySandboxTransport): WebhookTransport {
  return { dispatchBoundary: transport.sandbox.harnessGuardedJob ? "host-permit" : "sandbox-admission", request: async request => {
    request = { ...request, headers: { ...request.headers }, notAcceptedStatuses: [...request.notAcceptedStatuses] };
    if (request.owner !== owner || request.redirect !== "manual") throw Error("webhook_sandbox_owner_or_redirect");
    const url = webhookTarget(request.url);
    const values: Record<string, string> = {}, inputs: {name:string;type:"string";required:true}[] = [];
    const parameter = (name: string, value: string): ValueProducer => {
      values[name] = value;inputs.push({name,type:"string",required:true});return {kind:"input",name};
    };
    const pathParameters: Record<string, ValueProducer> = {};
    const segments = url.pathname.split("/").slice(1);
    const path = "/" + segments.map((segment, i) => {
      if (!segment) return "";
      const name = `path${i}`;
      const value = decodeURIComponent(segment);
      if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) throw Error("webhook_sandbox_path");
      pathParameters[name] = parameter(name, value);
      return `{${name}}`;
    }).join("/");
    const query: Record<string, ValueProducer> = {};
    for (const [name, value] of url.searchParams) {
      if (Object.hasOwn(query,name)) throw Error("webhook_sandbox_duplicate_query");
      query[name] = parameter(`query${Object.keys(query).length}`,value);
    }
    const reconstructed = new URL(url.origin + "/" + segments.map(s=>encodeURIComponent(decodeURIComponent(s))).join("/"));
    for(const [name,value] of url.searchParams) reconstructed.searchParams.set(name,value);
    // Preserve the exact URL covered by the signature, including percent encoding.
    if(reconstructed.href!==url.href) throw Error("webhook_sandbox_noncanonical_url");
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name,value],i)=>[name,parameter(`header${i}`,value)]));
    const body = request.body === undefined ? undefined : parameter("body",request.body);
    const expectedStatuses = [...new Set([200,201,202,203,204,205,206,207,208,226,...request.notAcceptedStatuses])];
    const graph = validateSiteHarnessArtifact({schemaVersion:2,executorAbi:"site-harness/1",siteId:"webhook-delivery",version:"1",
      sourceCaptureDigest:`sha256:${request.policyDigest}`,allowedOrigins:[url.origin],actions:[{id:"deliver",inputs,
        steps:[{id:"deliver",dependsOn:[],method:request.method,origin:url.origin,path,pathParameters,query,headers,
          ...(body===undefined?{}:{body}),expectedStatuses}]}]});
    const artifact={kind:"network" as const,graph,actionId:"deliver"};
    const environmentDigest=await transport.sandbox.harnessEnvironment(request.signal);
    const job:SandboxJob={version:1,operationId:`webhook:${request.operationId}`,owner,contextRef:request.policyDigest,
      authorityRef:request.authorityRef,artifact,harnessDigest:await sandboxDigest(artifact),dependencyLock:{},
      dependencyLockDigest:await sandboxDigest({}),environmentDigest,input:values,
      authority:{origins:[url.origin],methods:[request.method]},
      budget:{wallMs:10000,requests:1,outputBytes:request.maxResponseBytes}};
    let rawReceipt;
    if (request.authorizeDispatch) {
      if (!transport.sandbox.harnessGuardedJob) throw Error("webhook_private_permit_unavailable");
      job.dispatch = { protocol: "host-request/v1" };
      rawReceipt = await transport.sandbox.harnessGuardedJob(job, async challenge => {
        const prepared = challenge.prepared;
        // Exact signed bytes are checked independently of the graph interpreter.
        if (prepared.url !== url.href || prepared.method !== request.method || prepared.body !== request.body)
          throw Error("webhook_private_request_changed");
        const expected = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
        Object.assign(expected, { "user-agent": "Aiko/1.0 (observed-network)", "accept-encoding": "identity", accept: expected.accept ?? "application/json,text/plain,text/html" });
        if (JSON.stringify(Object.entries(expected).sort()) !== JSON.stringify(Object.entries(prepared.headers).sort()))
          throw Error("webhook_private_headers_changed");
        return request.authorizeDispatch!(challenge);
      }, request.signal);
    } else {
      await request.beforeDispatch();
      rawReceipt = await transport.sandbox.harnessJob(job,request.signal);
    }
    const receipt=await verifySandboxReceipt(job,rawReceipt);
    if(receipt.status!=="completed")throw Error("webhook_sandbox_outcome_unknown");
    const output=receipt.output as {result?:{trace?:{type:string;status?:number}[]};terminal?:unknown};
    const responses=output.result?.trace?.filter(e=>e.type==="response_received") ?? [];
    if(receipt.requests!==1 || responses.length!==1 || !Number.isInteger(responses[0]!.status))throw Error("webhook_sandbox_response_missing");
    return {status:responses[0]!.status!,...(request.method==="GET" ? {body:typeof output.terminal==="string"?output.terminal:JSON.stringify(output.terminal)} : {})};
  } };
}
