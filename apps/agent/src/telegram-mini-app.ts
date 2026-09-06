export const AIKO_MINI_APP_URL =
  "https://aiko-agent.lewis-6d8.workers.dev/connect";
const connectionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A connection ID selects a screen; the authenticated API still owns access. */
export function connectionMiniAppUrl(
  connectionId: string,
  base = AIKO_MINI_APP_URL,
): string {
  if (!connectionIdPattern.test(connectionId))
    throw new Error("Invalid connection ID");
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Mini App URL");
  url.searchParams.set("connection", connectionId);
  return url.href;
}

/** Only our configured entry point and a single non-secret connection selector. */
export function trustedMiniAppUrl(value: string, base?: string): boolean {
  if (!base) return false;
  try {
    const url = new URL(value),
      configured = new URL(base);
    if (
      configured.protocol !== "https:" ||
      configured.username ||
      configured.password ||
      configured.search ||
      configured.hash ||
      url.username ||
      url.password ||
      url.hash ||
      url.origin !== configured.origin ||
      url.pathname !== configured.pathname
    )
      return false;
    if (!url.search) return true;
    const entries = [...url.searchParams];
    return (
      entries.length === 1 &&
      entries[0]![0] === "connection" &&
      connectionIdPattern.test(entries[0]![1])
    );
  } catch {
    return false;
  }
}

/** Host-owned menu updates are serialized so an older count cannot overwrite a newer one. */
export function approvalMenu(options: {token?:string; owner:string; fetch?:typeof fetch; url?:string}) {
  let pending=Promise.resolve();
  return (count:number):Promise<void> => {
    if (!options.token || !/^[1-9]\d{0,15}$/.test(options.owner)) return Promise.resolve();
    const update=async () => {
      const url=new URL(options.url ?? AIKO_MINI_APP_URL);
      if(count>0)url.searchParams.set("screen","approvals");
      const response=await (options.fetch ?? fetch)(`https://api.telegram.org/bot${options.token}/setChatMenuButton`, {
        method:"POST", headers:{"Content-Type":"application/json"}, signal:AbortSignal.timeout(10000),
        body:JSON.stringify({chat_id:Number(options.owner),menu_button:{type:"web_app",text:count>0?`Approvals (${count})`:"Connect",web_app:{url:url.href}}}),
      });
      const result=await response.json() as {ok?:boolean};
      if(!response.ok || !result.ok)throw Error("Mini App menu update failed");
    };
    pending=pending.catch(()=>{}).then(update);
    return pending;
  };
}
