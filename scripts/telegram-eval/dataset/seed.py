"""Rebuild the local question bank from durable synthetic and Reddit inputs. No network, credentials, or Telegram sends."""
import csv
import hashlib
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = '2026-09-08-reddit-1'

# Original synthetic prompts: none are quotations or verified Reddit requests.
# Group variants together when splitting to prevent paraphrase leakage.
FAMILIES = [
 ('inbox', 'Inbox and messages', 'email_read', 'fixture_required', [
  ('I have 40 unread emails. Which three actually need me today?', 'Identify three urgent items from a supplied dated inbox; explain urgency without inventing messages.'),
  ('Summarise my unread emails in five bullets. Skip newsletters.', 'Exclude newsletter fixtures; keep five bullets with decisions and deadlines.'),
  ('Draft a polite no to this invitation: Can you volunteer all Saturday? I am busy.', 'Produce a ready-to-send decline without making up an excuse; do not send it.'),
  ('Find the email about my delivery and tell me when it should arrive.', 'Locate the matching fixture and distinguish estimated from confirmed arrival.'),
  ('Which of these emails can wait until Monday?', 'Use a supplied inbox and reference date; preserve time-sensitive items and explain the selection.')]),
 ('calendar', 'Scheduling and calendar', 'calendar_read', 'fixture_required', [
  ('Find a half-hour slot for me and Maya next week, after lunch.', 'Compare fixture calendars, timezone and lunch constraint; return available slots.'),
  ('Do I have time to get from my 2pm meeting to my 3pm appointment?', 'Use event locations and travel evidence; disclose travel uncertainty.'),
  ('Move my Friday dentist appointment to next week if possible. Show me options first.', 'Find options from fixtures; do not change the appointment before selection.'),
  ('Can you put all these deadlines into a simple plan for the week?', 'Use supplied deadlines; preserve due dates and realistic available time.'),
  ('What have I got tomorrow? Just the times and places.', 'Resolve tomorrow from the test clock and timezone; return only fixture events, times and locations.')]),
 ('reminders', 'Reminders and follow-through', 'reminder_write', 'test_clock_required', [
  ('Remind me to put the bins out every Tuesday evening.', 'Ask for a time if needed; confirm only a reminder verified in the test store.'),
  ('In 20 minutes, remind me to take the washing out.', 'Persist the correct due time and deliver under a controlled test clock.'),
  ('If I have not replied to the plumber by tomorrow, nudge me.', 'Represent the condition using supported capabilities or explain exactly what is missing.'),
  ('Stop my water reminders but keep my Tuesday bin reminder.', 'Cancel only the matching fixture reminders; verify the remaining reminder.'),
  ('Did you actually set that reminder?', 'Check the preceding test reminder record instead of claiming success from memory.')]),
 ('priorities', 'Overwhelm and daily planning', 'conversation', 'read_only', [
  ('I have laundry, two emails and a report due at 5. I am overwhelmed. What do I do first?', 'Offer a small actionable first step and protect the report deadline; avoid a long motivational speech.'),
  ('I only have 25 minutes before school pickup. Help me make a start on cleaning.', 'Give a realistic short plan that fits 25 minutes.'),
  ('My to-do list is a mess: renew passport, buy milk, finish slides for tomorrow. Sort it out.', 'Prioritise the explicit deadline; identify any missing urgent deadline without inventing one.'),
  ('Break updating my CV into tiny steps. I keep putting it off.', 'Give manageable concrete steps and one easy starting action.'),
  ('I missed everything on my plan yesterday. Help me restart without a lecture.', 'Use a respectful tone and a short reset plan without guilt or diagnosis.')]),
 ('local_food', 'Local food and outings', 'web_search,browser', 'read_only', [
  ('Find two cheap lunches near Clementi MRT. One of us is vegetarian.', 'Provide two sourced nearby choices with suitable dishes; distinguish verified prices from estimates.'),
  ('Somewhere quiet for coffee near Bugis tomorrow afternoon?', 'Find sourced options, address likely noise uncertainty and check relevant opening hours.'),
  ('Dinner for four under S$100 near Jurong East. No seafood.', 'Respect group budget and food restriction; state uncertainty about fees or menu prices.'),
  ('It is raining. Give me two indoor things to do in Singapore with a 7-year-old.', 'Suggest sourced age-appropriate indoor options with practical location details.'),
  ('Which of those lunch places is the shortest walk from the MRT?', 'Use the preceding options and route evidence; do not substitute unrelated places.')]),
 ('travel', 'Trips and travel administration', 'web_search,browser', 'read_only', [
  ('Plan a relaxed two-day Penang trip. I like food and hate rushing.', 'Group nearby stops into a realistic itinerary with sourced practical details.'),
  ('Compare the total cost of these two flights, including a checked bag.', 'Use supplied flight fare rules; compare totals in one currency and flag unknown charges.'),
  ('What should I pack for a three-day work trip to Tokyo next week?', 'Use dated weather evidence and the trip duration; give a compact relevant list.'),
  ('Find three hotels near this conference venue under S$180 a night. Do not book.', 'Request missing venue or dates; compare sourced total prices and location without booking.'),
  ('My flight lands at midnight. What are my options for getting to the hotel?', 'Request missing airport/hotel/date; use relevant late-night transport schedules and costs.')]),
 ('shopping', 'Shopping comparisons', 'web_search,browser', 'read_only', [
  ('Find a quiet fan for my bedroom under S$80. I just want two options.', 'Return two sourced in-budget fans; support noise claims or label them uncertain.'),
  ('Which of these two laptops is better for spreadsheets and video calls?', 'Use supplied models and verified specifications; recommend one with a plain-language reason.'),
  ('Can you find this replacement vacuum filter from the model number in my photo?', 'Extract the model from a fixture photo and verify compatibility using product evidence.'),
  ('Is this sale actually cheaper once delivery is included?', 'Calculate delivered totals from supplied offers; disclose missing taxes or shipping.'),
  ('Pick a birthday gift for my dad under S$50. He gardens and does not like gadgets.', 'Suggest sourced options matching interests and budget without buying anything.')]),
 ('meal_planning', 'Meals and groceries', 'conversation', 'read_only', [
  ('Plan three cheap vegetarian dinners and one shopping list for two people.', 'Provide three feasible dinners and consolidated quantities for two people.'),
  ('I have eggs, rice, spinach and tofu. What can I make in 15 minutes?', 'Suggest a feasible meal based on the listed ingredients and time.'),
  ('Make this shopping list less expensive without changing all the meals.', 'Use a supplied list and prices; propose specific lower-cost substitutions with accurate totals.'),
  ('We are four people now, not two. Update the grocery quantities.', 'Use the preceding meal plan; scale quantities consistently and preserve dietary constraints.'),
  ('Give me lunches I can prep on Sunday and take to work. No microwave there.', 'Provide practical lunches that work without reheating and a concise prep plan.')]),
 ('household', 'Household administration', 'web_search,browser', 'read_only', [
  ('Help me compare these three cleaning quotes. What is missing from each?', 'Compare supplied quotes on scope, frequency and total cost; identify omissions.'),
  ('Find a plumber near me who works on Saturdays. Give me three options.', 'Ask for location if absent; provide sourced options and distinguish advertised from confirmed availability.'),
  ('Draft a message to my landlord about the leaking kitchen tap.', 'Write a clear repair request without inventing dates, damage or promises; do not send.'),
  ('I am moving house in two weeks. What admin do I need to sort out?', 'Give a prioritised two-week checklist; ask jurisdiction only where it changes the advice.'),
  ('Turn this appliance warranty into a reminder of what I need to keep.', 'Extract the actual fixture warranty terms and required records; do not invent cover.')]),
 ('money_admin', 'Receipts and expense organisation', 'file_read,compute', 'fixture_required', [
  ('Add up these receipts and split the total between three of us.', 'Read fixture receipts, avoid duplicate entries and split the verified total with sensible rounding.'),
  ('Which subscriptions in this statement look like monthly repeats?', 'Identify fixture recurring charges with evidence; do not claim cancellation.'),
  ('Sort this spending CSV into groceries, transport and everything else.', 'Classify every row, disclose ambiguous items and reconcile category totals to the input.'),
  ('Did the restaurant charge us twice? Here are two transaction screenshots.', 'Compare fixture amounts, timestamps and pending/posted status; avoid unsupported certainty.'),
  ('Make a simple budget from these expenses. Explain it without finance jargon.', 'Use supplied income and expenses; calculate correctly and explain the remaining amount clearly.')]),
 ('documents', 'Document understanding', 'file_read', 'fixture_required', [
  ('What does this letter actually want me to do? Explain it simply.', 'Extract the requested action, deadline and consequences from the fixture; separate uncertainty.'),
  ('Summarise this 12-page report in five bullets for someone who knows nothing about it.', 'Preserve the report main findings in five plain-language bullets with no unsupported claims.'),
  ('Find the cancellation deadline in this agreement and show me where it says that.', 'Locate the actual deadline with page or section evidence; distinguish summary from legal advice.'),
  ('Compare these two versions. Did anything important change?', 'Identify substantive fixture differences and cite their locations.'),
  ('Turn these messy meeting notes into actions, owners and dates.', 'Extract known owners and dates; mark missing values rather than inventing them.')]),
 ('writing', 'Everyday writing and tone', 'conversation', 'read_only', [
  ('Make this sound polite but firm: You still have not paid invoice 17. It was due Friday.', 'Preserve the overdue invoice facts in a ready-to-send message without invented fees or threats.'),
  ('Rewrite this in under 35 words: We cannot ship today. Your address is incomplete. Send your postcode and apartment number.', 'Keep the shipping delay and both requested address fields; stay under 35 words and add no shipping promise.'),
  ('Help me apologise for being late without making up an excuse.', 'Produce a short natural apology with no fabricated reason.'),
  ('Make this less corporate: Please be advised that your request has been duly received.', 'Return a plain natural acknowledgement without adding unsupported next steps.'),
  ('Translate this into plain English: Your application is pending verification of supporting documentation.', 'Explain that the submitted documents still need checking without claiming rejection or approval.')]),
 ('customer_support', 'Customer service assistance', 'file_read,conversation', 'fixture_required', [
  ('Write a reply to this customer asking where their parcel is.', 'Use supplied order/tracking evidence; give a truthful status without inventing delivery promises.'),
  ('Summarise the complaints in these ten support tickets. What keeps coming up?', 'Group fixture complaints and support counts with ticket references.'),
  ('Help me explain our return policy without sounding rude.', 'Use the supplied policy accurately in a friendly concise reply.'),
  ('Which tickets should I deal with first today?', 'Prioritise fixture urgency and deadlines; explain the top choices.'),
  ('This customer has asked three times. Draft a reply that actually answers them.', 'Address the unanswered question using fixture conversation history; avoid another empty acknowledgement.')]),
 ('content', 'Content and small business marketing', 'conversation,media_generation', 'fixture_required', [
  ('Give me five Instagram post ideas for my neighbourhood bakery.', 'Produce five distinct practical ideas relevant to a bakery without invented promotions.'),
  ('Turn this product description into a short caption that sounds like me.', 'Preserve product facts and use supplied voice examples; avoid invented claims.'),
  ('Make a week of posts from this blog article, without repeating the same point.', 'Create distinct posts grounded in the supplied article and an explicit week schedule.'),
  ('Generate a casual product photo using the image tool available to you.', 'Check available media tools, execute when configured and return the actual artifact; otherwise name the specific missing prerequisite.'),
  ('Can you use your sandbox to call my configured image API and return the image?', 'Use the configured test API and actual sandbox capabilities; never falsely deny code execution or expose the secret.')]),
 ('research', 'Research and shortlists', 'web_search,browser', 'read_only', [
  ('Find three venues for a 20-person workshop near the city centre. What do you need from me?', 'Ask for the missing city and essential date/budget details in a concise bundled question.'),
  ('Compare these three coworking spaces. I care about quiet and price.', 'Use current sources for price and available noise evidence; distinguish subjective impressions.'),
  ('What are customers complaining about in these product reviews?', 'Summarise supplied reviews with evidence and frequency counts; do not present the sample as all customers.'),
  ('Find the official instructions for renewing this membership and give me the steps.', 'Use the specified organisation official source; explain steps, fees and dates only when verified.'),
  ('Check whether this event is still happening this weekend.', 'Use a dated official event source and distinguish scheduled from confirmed recent status.')]),
 ('spreadsheets', 'Spreadsheets and data cleanup', 'file_read,compute', 'fixture_required', [
  ('Remove duplicate rows from this contact spreadsheet and give me the cleaned file.', 'Apply a stated duplicate rule to fictional fixture contacts and return a verified file with row counts.'),
  ('Which products made the most money in this sales CSV?', 'Compute revenue using quantity times price and return the correctly ranked products.'),
  ('Turn this table in a photo into a spreadsheet.', 'Extract the fixture table accurately, flag unreadable cells and return a usable artifact.'),
  ('Combine these two expense sheets without counting the same receipt twice.', 'Join fixtures with an explicit duplicate rule and reconcile the resulting total.'),
  ('Sort Mei, Aaron and Zoe alphabetically. Reply only with a JSON array.', 'Return exactly ["Aaron","Mei","Zoe"] as parseable JSON, without extra text.')]),
 ('jobs', 'Job search administration', 'conversation,file_read', 'fixture_required', [
  ('Tailor my CV to this job, but do not add skills I do not have.', 'Use supplied CV and job description; preserve factual experience and avoid invented qualifications.'),
  ('Make a tracker for these five jobs I applied to.', 'Create a usable tracker from fixtures; preserve statuses and mark unknown dates.'),
  ('Explain this job description in normal language. What would I do every day?', 'Translate the actual responsibilities into plain language without inventing daily duties.'),
  ('Write a short follow-up after my interview last Tuesday.', 'Draft a concise polite message; use supplied details and do not send it.'),
  ('Help me prepare three questions to ask at this interview.', 'Produce three relevant questions grounded in the supplied role and organisation details.')]),
 ('family', 'Family and event coordination', 'conversation,file_read', 'fixture_required', [
  ('Plan a picnic for four under S$45. One person is vegetarian.', 'Give a realistic food plan within the stated total budget and dietary constraint.'),
  ('Turn this school newsletter into dates and things I need to do.', 'Extract fixture deadlines and parent actions; omit unrelated newsletter material.'),
  ('Organise a simple birthday party for eight kids. I have two hours and S$120.', 'Respect time, group size and total budget without claiming bookings.'),
  ('Draft one message asking the group who can come on Saturday.', 'Produce a short clear RSVP draft; do not message the group.'),
  ('Actually there are six of us now. Keep the same total budget and vegetarian option.', 'Apply the correction to a supplied prior picnic plan; preserve budget and dietary requirements.')]),
 ('technical_help', 'Plain-language technical help', 'browser,compute', 'test_service_required', [
  ('This page says session expired. What should I do?', 'Explain the issue simply and suggest the relevant sign-in action without exposing browser controls.'),
  ('Can you run a little script to add these numbers: 12, 49, 8 and 31?', 'Execute in the actual test sandbox and report the verified total 100.'),
  ('Open example.com and tell me the heading and where its information link goes.', 'Verify browser evidence for Example Domain and the IANA destination.'),
  ('Run a job that takes a little while and tell me when the result is ready.', 'Use a bounded 12-second test job, verify completion and choose useful progress communication.'),
  ('The browser failed. Can you explain what happened without the technical codes?', 'Explain the injected failure truthfully, preserve useful partial results and provide an actionable next step.')]),
 ('conversation_repair', 'Corrections, delays and unclear requests', 'conversation', 'scenario_required', [
  ('You only reacted to my last message. Can you actually answer it?', 'Answer the preceding fixture request in text; a reaction or apology alone is insufficient.'),
  ('Are you still working on it?', 'Use the active fixture job status; give a truthful specific update without restarting the job.'),
  ('That is too complicated. Explain it like I have never used this before.', 'Simplify the preceding fixture explanation without changing its facts or being patronising.'),
  ('No, I meant next Friday, not tomorrow.', 'Apply the correction against a fixed test date/timezone and verify before changing any fixture record.'),
  ('Can you sort that thing out for me?', 'Ask a short clarifying question when fixture context cannot resolve the task; do not invent an intent.')]),
]


def build():
    research = json.loads((ROOT / 'research-status.json').read_text())
    records = []
    for index, (family, category, tools, mode, questions) in enumerate(FAMILIES):
        # Five-category blocks have 3 dev / 1 validation / 1 holdout families.
        split = ('development', 'development', 'development', 'validation', 'holdout')[index % 5]
        for number, (prompt, outcome) in enumerate(questions, 1):
            records.append(dict(
                id=f'{family}-{number:02}', family=family, category=category,
                prompt=prompt, expected_outcome=outcome,
                provenance='synthetic', source_id=None,
                review_status='needs_reddit_validation', dataset_version=VERSION,
                split=split, capabilities=tools.split(','), execution_mode=mode,
                fixture_status='not_prepared' if mode != 'read_only' else 'review_required',
                runnable=False,
                rubric=['task_completion', 'grounding', 'natural_language', 'layman_clarity', 'progress_usefulness'],
            ))
    corpus = json.loads((ROOT / 'reddit-corpus.json').read_text())
    sources = corpus['sources']
    source_ids = {source['id'] for source in sources}
    assert len(source_ids) == len(sources)
    assert len({source['url'] for source in sources}) == len(sources)
    for record in records:
        record.update(source_url=None, parent_question_id=None,
                      conversation_turns=[record['prompt']], retrieval_mode=None)
    for index, source in enumerate(sources):
        split = ('development', 'development', 'development', 'validation', 'holdout')[index % 5]
        assert (ROOT / source['evidence_path']).is_file()
        for number, task in enumerate(source['tasks'], 1):
            base_id = f"{source['id']}-{number:02}"
            for variant in (False, True):
                prompt = task['variant_prompt'] if variant else task['prompt']
                records.append(dict(
                    id=base_id + ('-followup' if variant else ''),
                    family=source['id'], category=task['category'], prompt=prompt,
                    expected_outcome=task['variant_expected_outcome'] if variant else task['expected_outcome'],
                    provenance='reddit_derived_variant' if variant else 'reddit_paraphrase',
                    source_id=source['id'], source_url=source['url'],
                    review_status='verified', dataset_version=VERSION, split=split,
                    capabilities=task['capabilities'], execution_mode='scenario_required',
                    fixture_status='not_prepared', runnable=False,
                    rubric=['task_completion', 'grounding', 'natural_language', 'layman_clarity', 'progress_usefulness'],
                    parent_question_id=base_id if variant else None,
                    conversation_turns=[task['prompt'], prompt] if variant else [prompt],
                    retrieval_mode=source['retrieval_mode'],
                ))
    assert len({r['id'] for r in records}) == len(records)
    assert len({r['prompt'].casefold().strip() for r in records}) == len(records)
    for record in records:
        assert not record['runnable']
        assert record['provenance'] == 'synthetic' or record['source_id'] in source_ids
    by_id = {record['id']: record for record in records}
    for record in records:
        if record['parent_question_id']:
            parent = by_id[record['parent_question_id']]
            assert (parent['source_id'], parent['split']) == (record['source_id'], record['split'])
    jsonl = ''.join(json.dumps(r, ensure_ascii=False, sort_keys=True) + '\n' for r in records)
    (ROOT / 'questions.jsonl').write_text(jsonl)
    with (ROOT / 'questions.csv').open('w', newline='') as f:
        fields = ['id', 'family', 'category', 'prompt', 'expected_outcome', 'provenance',
                  'source_id', 'source_url', 'parent_question_id', 'review_status', 'split', 'execution_mode', 'fixture_status', 'runnable']
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(records)
    path = ROOT / 'questions.sqlite'
    # Source evidence lives in reddit-corpus.json; run results belong elsewhere.
    # Validate the replacement before touching the last usable SQLite snapshot.
    temporary_path = ROOT / 'questions.build.sqlite'
    temporary_path.unlink(missing_ok=True)
    with sqlite3.connect(temporary_path) as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.executescript('''
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE sources (
            id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
            subreddit TEXT, published_at TEXT, retrieved_at TEXT NOT NULL,
            evidence_path TEXT NOT NULL, request_summary TEXT NOT NULL,
            requester_type TEXT NOT NULL, review_status TEXT NOT NULL,
            retrieval_mode TEXT NOT NULL, evidence_scope TEXT NOT NULL
          );
          CREATE TABLE questions (
            id TEXT PRIMARY KEY, family TEXT NOT NULL, category TEXT NOT NULL,
            prompt TEXT NOT NULL, expected_outcome TEXT NOT NULL,
            provenance TEXT NOT NULL CHECK(provenance IN ('synthetic','reddit_paraphrase','reddit_derived_variant')),
            source_id TEXT REFERENCES sources(id), review_status TEXT NOT NULL,
            dataset_version TEXT NOT NULL,
            split TEXT NOT NULL CHECK(split IN ('development','validation','holdout')),
            capabilities_json TEXT NOT NULL, execution_mode TEXT NOT NULL,
            fixture_status TEXT NOT NULL, runnable INTEGER NOT NULL CHECK(runnable IN (0,1)),
            rubric_json TEXT NOT NULL,
            parent_question_id TEXT REFERENCES questions(id),
            conversation_turns_json TEXT NOT NULL,
            CHECK(provenance = 'synthetic' OR source_id IS NOT NULL)
          );
          CREATE INDEX questions_category ON questions(category, split);
          CREATE INDEX questions_provenance ON questions(provenance, review_status);
          CREATE VIEW verified_reddit_questions AS
            SELECT q.*, s.url AS source_url, s.retrieval_mode, s.evidence_scope
            FROM questions q JOIN sources s ON s.id=q.source_id
            WHERE q.provenance != 'synthetic' AND q.review_status='verified'
              AND s.review_status='verified';
        ''')
        db.executemany('INSERT INTO metadata VALUES (?,?)', [
            ('version', VERSION), ('reddit_research_status', research['status']),
            ('question_count', str(len(records))), ('verified_reddit_source_count', str(len(sources))),
            ('questions_sha256', hashlib.sha256(jsonl.encode()).hexdigest()),
            ('warning', 'Sourced intents reviewed against search excerpts, not full threads; synthetic and generated variants labelled; no cases enabled.'),
            ('review_definition', 'verified means agent-checked provenance against the returned excerpt, not human review or independent verification of the author account.'),
            ('reddit_corpus_sha256', hashlib.sha256((ROOT / 'reddit-corpus.json').read_bytes()).hexdigest()),
        ])
        db.executemany('INSERT INTO sources VALUES (' + ','.join('?' for _ in range(12)) + ')', [
            tuple(source[k] for k in ['id','url','title','subreddit','published_at','retrieved_at',
                  'evidence_path','request_summary','requester_type','review_status','retrieval_mode','scope'])
            for source in sources
        ])
        db.executemany('INSERT INTO questions VALUES (' + ','.join('?' for _ in range(17)) + ')', [
            tuple(r[k] for k in ['id','family','category','prompt','expected_outcome','provenance',
                                 'source_id','review_status','dataset_version','split'])
            + (json.dumps(r['capabilities']), r['execution_mode'], r['fixture_status'],
               int(r['runnable']), json.dumps(r['rubric']),
               r['parent_question_id'], json.dumps(r['conversation_turns']))
            for r in records
        ])
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        assert db.execute('SELECT COUNT(*) FROM verified_reddit_questions').fetchone()[0] == sum(r['provenance'] != 'synthetic' for r in records)
        assert not db.execute('SELECT source_id FROM questions WHERE source_id IS NOT NULL GROUP BY source_id HAVING COUNT(DISTINCT split)>1').fetchall()
        assert not db.execute('SELECT family FROM questions GROUP BY family HAVING COUNT(DISTINCT split)>1').fetchall()
    temporary_path.replace(path)
    with (ROOT / 'sources.csv').open('w', newline='') as f:
        fields = ['id','url','title','subreddit','published_at','retrieved_at','request_summary',
                  'requester_type','retrieval_mode','scope','review_status','evidence_path']
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(sources)
    print(json.dumps({'questions': len(records), 'split_groups': len({r['family'] for r in records}),
                      'verified_reddit_sources': len(sources), 'database': str(path)}))


if __name__ == '__main__':
    build()
