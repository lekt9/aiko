import type {Database} from "bun:sqlite";
import type {Event} from "tardie/core/event";
import type {NativeLoginState} from "./native-login.ts";
import {loginObservationEvent} from "./native-login-observation.ts";
/** State and value-free observation custody commit atomically in the existing VM database. */
export function nativeLoginMetadataJournal(db:Database,owner:string) {
  db.exec("CREATE TABLE IF NOT EXISTS native_login(id TEXT PRIMARY KEY,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS native_login_outbox(id TEXT PRIMARY KEY,event TEXT NOT NULL)");
  return {
    save(state:NativeLoginState) {
      db.transaction(()=>{
        db.query("INSERT INTO native_login(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(state.connectionId,JSON.stringify(state));
        for(const receipt of state.loginReceipts??[])db.query("INSERT OR IGNORE INTO native_login_outbox(id,event) VALUES(?,?)").run(receipt.id,JSON.stringify(loginObservationEvent(owner,receipt)));
      })();
    },
    async flush(emit:(event:Event)=>Promise<unknown>) {
      for(const row of db.query("SELECT id,event FROM native_login_outbox WHERE event != '' ORDER BY rowid").all() as {id:string;event:string}[]) {
        await emit(JSON.parse(row.event));
        // Retain the dedup identity so subsequent state saves cannot requeue it.
        db.query("UPDATE native_login_outbox SET event='' WHERE id=?").run(row.id);
      }
    },
  };
}
