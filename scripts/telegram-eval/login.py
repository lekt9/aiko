#!/usr/bin/env python3
"""Create a private Telethon user session for the Aiko evaluator. Sends no chat messages."""
import argparse
import asyncio
from getpass import getpass
import json
import os
from pathlib import Path
import re

async def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,default=Path.home()/'.config/unbrowse/telegram-eval')
    args=parser.parse_args()
    from telethon import TelegramClient
    os.umask(0o077)
    directory=args.directory.expanduser().resolve()
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    directory.chmod(0o700)
    config_path=directory/'config.json'
    config=json.loads(config_path.read_text()) if config_path.exists() else {}
    api_id=str(config.get('api_id') or input('Telegram API ID (from my.telegram.org): ').strip())
    api_hash=config.get('api_hash') or getpass('Telegram API hash (hidden): ').strip()
    phone=input('Your phone number, including country code: ').strip()
    if not api_id.isdigit() or int(api_id)<=0 or not re.fullmatch(r'[a-fA-F0-9]{32}',api_hash):
        raise ValueError('Invalid API ID or hash')
    digits=lambda text:''.join(c for c in str(text) if c.isdigit())
    if not 7<=len(digits(phone))<=15:raise ValueError('Invalid phone number')
    session=directory/'user.session'
    client=TelegramClient(str(session),int(api_id),api_hash)
    try:
        await client.start(phone=phone,code_callback=lambda:getpass('Telegram login code (hidden): ').strip(),password=lambda:getpass('Telegram two-step verification password (hidden): '))
        me=await client.get_me()
        if me.bot or digits(me.phone)!=digits(phone):
            raise ValueError('Existing session belongs to a different account; choose another --directory')
        fd=os.open(config_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as f:
            json.dump({'api_id':int(api_id),'api_hash':api_hash,'session_path':str(session),'owner':str(me.id)},f)
        config_path.chmod(0o600)
        print(f'Session ready: {session}')
        print(f'Evaluator configuration: {config_path}')
    finally:
        await client.disconnect()
        if session.exists():session.chmod(0o600)

if __name__=='__main__':
    try:asyncio.run(main())
    except KeyboardInterrupt:print('\nLogin cancelled.')
