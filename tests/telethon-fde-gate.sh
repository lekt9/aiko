#!/usr/bin/env bash
# Seven-point first-vertical witness. Provider records are synthetic and every
# effect assertion is per chat and recipient, never an aggregate count.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
python3 - "$ROOT" "$TMP" <<'PY'
import importlib.util,json,pathlib,sys
root,tmp=map(pathlib.Path,sys.argv[1:])
p=root/'cell/adapters/telethon/telethon_vertical.py'
spec=importlib.util.spec_from_file_location('telethon_vertical',p); m=importlib.util.module_from_spec(spec); sys.modules[spec.name]=m; spec.loader.exec_module(m)
def put(name,value):
 q=tmp/name; q.write_text(json.dumps(value,sort_keys=True)); return q
now=1_700_000_000
cred=put('credential.json',{'schema':'aiko.credential-handle-contract/v1','handle':'cred:'+'a'*32,'tenant':'acme','origin':'https://telegram.example','account_id':'aiko-ops','allowed_actions':['observe','send'],'expires_at':now+600,'status':'active','revoked':False,'secret_retained':False})
admitted=put('adapter.json',{'schema':'aiko.admitted-adapter-family/v1','family':'worker-directory/v1','package_digest':'b'*64,'admitted_by_digest':True,'judgment':'accepted'})
context=put('context.json',{'schema':'aiko.cited-context-lineage/v1','tenant':'acme','sources':{},'claims':{}})
control=put('control.json',{'schema':'aiko.durable-pause-resume/v1','status':'running','cell_digest':'c'*64,'scheduler':False})
provider=m.SyntheticProvider(tmp/'provider-journal.json')
v=m.TelethonVertical(tmp/'state',provider,now=lambda:now)

# 1. Start empty; login consumes all settled contracts and retains only the
# opaque handle, never phone/code/2FA authorization material.
assert not (tmp/'state').exists()
handle=v.login(credential=cred,adapter_family=admitted,context=context,control=control,tenant='acme',phone='+15550000000',code='synthetic-code',two_factor='synthetic-2fa')
assert handle=='cred:'+'a'*32
raw=(tmp/'state/vertical.json').read_text()
for secret in ('+15550000000','synthetic-code','synthetic-2fa'): assert secret not in raw
assert json.loads(raw)['login']['credential_handle']==handle

# 2/3. Normalize at the membrane and enforce both chat and recipient scope.
v.grant('chat-ops',['alice','bob','carol']); v.grant('chat-other',['dave'])
e=v.normalize_inbound({'update_id':41,'chat_id':'chat-ops','sender_id':'alice','text':'confirmed','telethon_class':'UpdateNewMessage'})
assert e=={'kind':'inbound_message','conversation_id':'chat-ops','sender_id':'alice','body':'confirmed','source_id':'41'}
assert 'telethon' not in json.dumps(e).lower()
def refuses(fn,needle):
 try: fn()
 except m.Refusal as x: assert needle.lower() in str(x).lower(),x
 else: raise AssertionError('expected refusal: '+needle)
refuses(lambda:v.normalize_inbound({'update_id':42,'chat_id':'chat-other','sender_id':'alice','text':'x'}),'ACL')
refuses(lambda:v.send('chat-ops','dave','wrong chat'),'ACL')
assert provider.calls==[]

# 4. Sender intent is settled only when the separate provider journal agrees.
r=v.send('chat-ops','alice','shift A',key='initial:alice')
assert r['crossed'] and r['status']=='settled' and r['read_back']
observed=provider.read_back('initial:alice'); assert observed['recipient_id']=='alice' and observed['chat_id']=='chat-ops' and observed['text']=='shift A'

# 5. Establish a roster, then amend it. Alice is byte-for-byte unchanged: only
# Bob and Carol may be contacted, asserted by individual recipient identities.
v.apply_assignments('chat-ops',{'alice':'A','bob':'B','carol':'C'})
provider.calls.clear()
changed=v.apply_assignments('chat-ops',{'alice':'A','bob':'C','carol':'B'})
assert changed==['bob','carol']
assert provider.calls==[('chat-ops','bob','amend:bob:C'),('chat-ops','carol','amend:carol:B')],provider.calls
assert all(call[1]!='alice' for call in provider.calls)
for recipient,shift in [('bob','C'),('carol','B')]:
 row=provider.read_back(f'amend:{recipient}:{shift}')
 assert row and row['chat_id']=='chat-ops' and row['recipient_id']==recipient

# 6/7. An unobservable but crossed send stays pending; redrive classifies it but
# never invokes send again. An expired credential also stays pending and never
# crosses the provider boundary.
provider.calls.clear(); pending=v.send('chat-ops','alice','unobservable',observable=False,key='opaque-send')
assert pending['crossed'] and pending['status']=='pending' and not pending['read_back']
before=list(provider.calls); actions={x['message_id']:x for x in v.redrive()}
assert actions['opaque-send']['action']=='do-not-resend' and provider.calls==before
expired_data=json.loads(cred.read_text()); expired_data['expires_at']=now; expired=put('expired.json',expired_data)
provider.calls.clear(); er=v.send_if_authorized('chat-ops','bob','after expiry',expired)
assert er['status']=='pending' and not er['crossed'] and not er['read_back'] and provider.calls==[]
s=json.loads((tmp/'state/vertical.json').read_text())
assert any(x=={'message_id':'opaque-send','reason':'independent read-back unavailable'} for x in s['escalations'])
assert any(x['message_id']==er['message_id'] and x['reason']=='credential expired' for x in s['escalations'])
assert {x['action'] for x in v.redrive() if x['message_id']==er['message_id']}=={'pending'}
print('PASS telethon-fde: opaque login, neutral inbound, scoped ACL, read-back, delta amendment, no resend, expiry pending')
PY
