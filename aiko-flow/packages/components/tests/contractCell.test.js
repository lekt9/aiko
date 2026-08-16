import { expect, test } from "bun:test";
import { ContractCell } from "../src/index.js";
test("ContractCell routes execution through operational driver", async () => {
  const element=ContractCell({id:"x", output:{}, signal:{commitOrdinal:2}, driver:{handleSignal:async x=>({seen:x.commitOrdinal})}});
  expect(element.props.meta.authority).toBe("contract"); expect(await element.props.children({})).toEqual({seen:2});
});
