#!/usr/bin/env python3
"""Live Telethon evaluation + offline/host-only log assessment.

Sessions/credentials stay outside the repository. Live sends are opt-in through
--live and target only the configured Aiko bot, after checking phone and owner.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from evaluator import score, summarize, markdown, turn_events, events_of, deliveries, TERMINALS, correlate_inbound, correlate_deliveries

ROOT=Path(__file__).resolve().parents[2]

def now(): return int(time.time()*1000)

def private_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f,indent=2,ensure_ascii=False)

async def host(command, owner, after=0):
    proc=await asyncio.create_subprocess_exec('bun',str(ROOT/'scripts/telegram-eval/host.ts'),command,str(owner),str(after),stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,cwd=ROOT)
    try: stdout,_=await asyncio.wait_for(proc.communicate(),40)
    except asyncio.TimeoutError:
        proc.kill();await proc.wait();raise RuntimeError('Host telemetry request timed out')
    if proc.returncode:raise RuntimeError(f'Host {command} failed; no messages retried')
    return json.loads(stdout)

async def read_since(owner, after):
    rows=[]
    for _ in range(100):
        data=await host('events',owner,after)
        batch=data['events'];rows.extend(batch)
        cursor=data.get('nextAfter')
        if cursor is None:cursor=max([after]+[r['seq'] for r in batch])
        if not data.get('hasMore'):return rows,cursor
        if cursor<=after:raise RuntimeError('Log cursor stopped advancing')
        after=cursor
    raise RuntimeError('Log page bound exceeded')

def write_report(report, directory):
    report['summary']=summarize(report['results'])
    private_json(directory/'report.json',report)
    path=directory/'report.md';path.write_text(markdown(report));path.chmod(0o600)

async def historical(args, directory):
    if args.logs:rows=json.loads(Path(args.logs).read_text())
    else:
        data=await host('threads',args.owner)
        thread=next(t for t in data['threads'] if t['id']==f'user-{args.owner}')
        rows,_=await read_since(args.owner,max(0,thread['eventCount']-args.window))
    private_json(directory/'host-events.json',rows)
    events=events_of(rows)
    starts=[e for e in events if e.get('type')=='MessageReceived' and (args.include_automations or e.get('source')!='automation')]
    report={'mode':'historical_host_receipt_only','created_at_ms':now(),'results':[],'window_events':len(rows),'deployment':args.deployment}
    for start in starts:
        turn=turn_events(rows,start['id'])
        result=score(None,turn,end_ms=max((e.get('at',0) for e in events),default=now()) if args.logs else now())
        result['right_censored']=not any(e.get('type') in TERMINALS for e in turn)
        report['results'].append(result)
    write_report(report,directory)
    print(json.dumps(report['summary']),flush=True)

async def live(args,directory):
    from telethon import TelegramClient, events
    from telethon.sessions import StringSession
    from telethon.errors import FloodWaitError
    from cases import build
    config_path=Path(os.environ.get('TELETHON_CONFIG_PATH',Path.home()/'.config/unbrowse/telegram-eval/config.json')).expanduser()
    saved=json.loads(config_path.read_text()) if config_path.is_file() else {}
    api_id=os.environ.get('TELEGRAM_API_ID') or os.environ.get('TG_API_ID') or saved.get('api_id')
    api_hash=os.environ.get('TELEGRAM_API_HASH') or os.environ.get('TG_API_HASH') or saved.get('api_hash')
    session_path=args.session or os.environ.get('TELETHON_SESSION_PATH') or saved.get('session_path')
    session_string=os.environ.get('TELETHON_SESSION_STRING')
    if not api_id or not api_hash or not (session_path or session_string):
        raise RuntimeError('Missing Telethon API configuration/session. Set TELEGRAM_API_ID, TELEGRAM_API_HASH and TELETHON_SESSION_PATH outside the repository.')
    if not args.phone:raise RuntimeError('--phone is required to verify the authorized account')
    if session_path and not Path(session_path).is_file():raise RuntimeError('Session file not found; evaluator never silently creates/logs into another account')
    client=TelegramClient(StringSession(session_string) if session_string else session_path,int(api_id),api_hash,flood_sleep_threshold=0,request_retries=0)
    report={'mode':'telegram_live','created_at_ms':now(),'seed':args.seed,'deployment':args.deployment,'results':[],
      'limits':{'cases':args.count,'case_seconds':args.timeout,'session_seconds':args.session_timeout},
      'harness_sha256':hashlib.sha256(Path(__file__).read_bytes()+Path(__file__).with_name('evaluator.py').read_bytes()+Path(__file__).with_name('cases.py').read_bytes()).hexdigest()}
    await client.connect()
    try:
        if not await client.is_user_authorized():raise RuntimeError('Telethon session needs login; authenticate it separately before running the evaluator')
        me=await client.get_me()
        phone=lambda s:''.join(c for c in str(s) if c.isdigit())
        if phone(me.phone)!=phone(args.phone) or str(me.id)!=str(args.owner):raise RuntimeError('Session phone/owner mismatch; no test messages sent')
        bot=await host('bot',args.owner)
        peer=await client.get_entity(bot['username'])
        if peer.id!=bot['id'] or not peer.bot:raise RuntimeError('Aiko bot identity mismatch')
        report['bot_id']=peer.id
        report['readiness']=await host('ready',args.owner)
        data=await host('threads',args.owner)
        foreground=next(t for t in data['threads'] if t['id']==f'user-{args.owner}')
        if foreground['status']!='idle':raise RuntimeError('Aiko has an active user task; defer live evaluation')
        cursor=foreground['eventCount'];observed=[];external_input=[];sending=False;owned_ids=set()
        @client.on(events.NewMessage(chats=peer))
        async def message(event):
            nonlocal sending
            if event.out:
                if not sending and event.id not in owned_ids:external_input.append(event.id)
                return
            observed.append({'kind':'message','id':event.id,'at':now(),'server_at':int(event.date.timestamp()*1000),'reply_to':event.reply_to_msg_id,'text':event.raw_text,'media':type(event.media).__name__ if event.media else None})
        @client.on(events.MessageEdited(chats=peer,incoming=True))
        async def edited(event):
            # Preserve first visibility, retain the final edited text separately.
            old=next((r for r in observed if r['id']==event.id),None)
            if old:old['text']=event.raw_text;old['edited_at']=now()
            else:observed.append({'kind':'edit','id':event.id,'at':now(),'server_at':int(event.date.timestamp()*1000),'reply_to':event.reply_to_msg_id,'text':event.raw_text})
        cases=build(args.seed,directory)[:args.count]
        private_json(directory/'cases.json',cases)
        all_rows=[];session_deadline=time.monotonic()+args.session_timeout
        for case in cases:
            if external_input:report['stop_reason']='user_intervened';break
            if time.monotonic()>=session_deadline:report['stop_reason']='session_deadline';break
            start=now();sending=True
            try:
                if case.get('file'):
                    sent=await client.send_file(peer,case['file'],caption=case['prompt'],force_document=not case.get('photo',False))
                else:sent=await client.send_message(peer,case['prompt'],parse_mode=None)
                owned_ids.add(sent.id)
            except FloodWaitError:
                report['stop_reason']='telegram_rate_limit';break
            except Exception:
                # An ambiguous send may have arrived; never resend it automatically.
                report['stop_reason']='test_send_unconfirmed';break
            finally:sending=False
            print(json.dumps({'case':case['id'],'state':'sent','message_id':sent.id}),flush=True)
            private_json(directory/f"{case['id']}.sent.json",{'message_id':sent.id,'sent_at':start,'server_sent_at':int(sent.date.timestamp()*1000),'prompt':case['prompt']})
            turn_id=None;current=[];done=False;settled_since=None;last_progress=time.monotonic()
            deadline=min(time.monotonic()+args.timeout,session_deadline)
            while time.monotonic()<deadline:
                private_json(directory/'client-observations.json',observed)
                new,cursor=await read_since(args.owner,cursor);all_rows.extend(new)
                if turn_id is None:
                    inbound=correlate_inbound(new,args.owner,case['prompt'],int(sent.date.timestamp()*1000))
                    if inbound:turn_id=inbound['id']
                if turn_id:
                    current=turn_events(all_rows,turn_id)
                    delivered=deliveries(current)
                    final_ids={d['id'] for d in delivered if d['final']}
                    seen_ids={o['provider_id'] for o in correlate_deliveries(current,observed,sent.id)}
                    terminal=any(e.get('type') in TERMINALS for e in current)
                    if terminal and final_ids and final_ids<=seen_ids:
                        settled_since=settled_since or time.monotonic()
                        if time.monotonic()-settled_since>=3:done=True;break
                if time.monotonic()-last_progress>=30:
                    print(json.dumps({'case':case['id'],'state':'waiting','elapsed_seconds':round((now()-start)/1000),'turn_correlated':turn_id is not None}),flush=True)
                    last_progress=time.monotonic()
                if external_input:break
                await asyncio.sleep(2)
            result=score(case,current,observed,end_ms=now(),sent_ms=start,input_message_id=sent.id)
            result['message_id']=sent.id
            result['observation_deadline_reached']=not done
            report['results'].append(result)
            private_json(directory/f"{case['id']}.trace.json",current)
            ids=set(result['client_message_ids'])
            private_json(directory/f"{case['id']}.telegram.json",[o for o in observed if str(o['id']) in ids])
            write_report(report,directory)
            print(json.dumps({k:result[k] for k in ['case','objective_pass','first_message_ms','completion_ms','intermediate_messages','ux_flags']}),flush=True)
            if not done:
                report['stop_reason']='user_intervened' if external_input else 'turn_unsettled_or_no_final'
                break # Never pile test requests onto a hanging conversation.
            await asyncio.sleep(2)
        report.setdefault('stop_reason','case_limit')
    finally:
        await client.disconnect()
        write_report(report,directory)
    print(json.dumps(report['summary']),flush=True)

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner',required=True)
    parser.add_argument('--phone')
    parser.add_argument('--session')
    parser.add_argument('--deployment',default='unrecorded',help='Independently verified deployed Worker version; local source hash is not a deployment ID')
    parser.add_argument('--live',action='store_true')
    parser.add_argument('--logs',help='Evaluate an existing JSON event array offline')
    parser.add_argument('--include-automations',action='store_true')
    parser.add_argument('--window',type=int,default=1200)
    parser.add_argument('--seed',type=int,default=8129)
    parser.add_argument('--count',type=int,default=12)
    parser.add_argument('--timeout',type=int,default=180)
    parser.add_argument('--session-timeout',type=int,default=1800)
    parser.add_argument('--output',default=f'artifacts/telegram-eval/{time.strftime("%Y%m%d-%H%M%S")}')
    args=parser.parse_args()
    if not 1<=args.count<=30 or not 10<=args.timeout<=600 or not 10<=args.session_timeout<=7200:parser.error('Evaluation limits out of range')
    if not 100<=args.window<=10000:parser.error('--window must be 100..10000')
    directory=Path(args.output).resolve();directory.mkdir(parents=True,exist_ok=True,mode=0o700);directory.chmod(0o700)
    try:
        if args.live:await live(args,directory)
        else:await historical(args,directory)
    except Exception as error:
        private_json(directory/'run-status.json',{'state':'blocked_or_interrupted','live_requested':args.live,'reason':str(error) if isinstance(error,RuntimeError) else type(error).__name__,'at':now()})
        raise
    print(f'Report: {directory / "report.md"}',flush=True)

if __name__=='__main__':
    try:asyncio.run(main())
    except KeyboardInterrupt:print('Evaluation interrupted; no automatic resend.',file=sys.stderr);sys.exit(130)
    except Exception as error:
        # Telethon exceptions can contain request data. Keep the CLI failure bounded.
        print(f'Evaluation stopped: {error if isinstance(error,RuntimeError) else type(error).__name__}',file=sys.stderr);sys.exit(1)
