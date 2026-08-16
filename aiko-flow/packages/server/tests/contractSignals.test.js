import { expect, test } from "bun:test";
import { createContractSignalHandler, mountContractSignalRoutes } from "../src/index.js";

test("production Fetch route dispatches to Contract driver", async () => {
  const seen=[]; const handler=createContractSignalHandler({handleSignal: async x => (seen.push(x), {reread:true})});
  const response=await handler(new Request("http://local/v1/contract/signals/frontier", {method:"POST", body:JSON.stringify({commitOrdinal:9})}));
  expect(response.status).toBe(202); expect(await response.json()).toEqual({reread:true}); expect(seen).toEqual([{commitOrdinal:9}]);
});
test("Hono-compatible route is actually registered", async () => {
  let route; const app={post:(path, fn)=>{route={path,fn}}};
  mountContractSignalRoutes(app,{driver:{handleSignal:async x=>x}}); expect(route.path).toBe("/v1/contract/signals/frontier");
  const response=await route.fn({req:{json:async()=>({commitOrdinal:3})},json:(body,status)=>({body,status})});
  expect(response).toEqual({body:{commitOrdinal:3},status:202});
});
