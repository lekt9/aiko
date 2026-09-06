import {test,expect} from 'bun:test';
import {approvalMenu} from '../src/telegram-mini-app.ts';
test('menu count updates in order and returns to Connect after the queue clears',async()=>{
 const sent:any[]=[];
 const update=approvalMenu({owner:'123',token:'fixture',fetch:(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true});}) as typeof fetch});
 await Promise.all([update(5),update(4),update(0)]);
 expect(sent.map(x=>x.menu_button.text)).toEqual(['Approvals (5)','Approvals (4)','Connect']);
 expect(sent[0].menu_button.web_app.url).toContain('screen=approvals');
 expect(sent[2].menu_button.web_app.url).not.toContain('?');
 expect(sent.every(x=>x.chat_id===123)).toBe(true);
 const absent=approvalMenu({owner:'acct_probe',token:'fixture',fetch:(async()=>{throw Error('must not call Telegram');}) as unknown as typeof fetch});await absent(3);
});
