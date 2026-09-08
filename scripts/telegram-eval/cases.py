"""Seeded varied scenarios with fixed assertions; no payments or third-party sends."""
import csv
import random

def build(seed, directory):
    rng=random.Random(seed)
    a,b=rng.randint(130,290),rng.randint(21,49)
    numbers=[rng.randint(10,99) for _ in range(9)]
    total=sum(numbers)
    rows=[('tea',rng.randint(1,6),4),('noodles',rng.randint(1,6),7),('coffee',rng.randint(1,6),3)]
    csvpath=directory/'orders.csv'
    with csvpath.open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(['item','quantity','unit_price']);writer.writerows(rows)
    from PIL import Image, ImageDraw
    im=Image.new('RGB',(640,360),'white');draw=ImageDraw.Draw(im)
    for x in (70,200,330):draw.ellipse((x,100,x+75,175),fill='red')
    draw.rectangle((460,100,550,190),fill='blue');im.save(directory/'shapes.png')
    independent=[
      {'id':'arithmetic','category':'quick_answer','prompt':f'What is {a} times {b}? Just the number please.','exact':str(a*b)},
      {'id':'structured_output','category':'formatting','prompt':'Sort these names alphabetically: Mei, Aaron, Zoe. Reply only with a JSON array of the names.','json':['Aaron','Mei','Zoe']},
      {'id':'rewrite','category':'writing','prompt':'Rewrite this as a warm, clear message under 35 words: "We cannot ship today. The address is incomplete. Tell us your postcode and apartment number."','max_words':35,'contains':['postcode','apartment'],'review':['Keeps the shipping delay','Warm and direct','No invented promise']},
      {'id':'python_execution','category':'compute','prompt':f'Use your Codegraff sandbox to run Python that sums {numbers}. Tell me the result and the actual process exit code.','contains':[str(total)],'patterns':[r'exit.{0,20}0'],'compute':True},
      {'id':'delayed_execution','category':'long_work','prompt':f'Run a Python script in your sandbox that waits 12 seconds, then prints READY-{seed}. Wait for it to finish and tell me its output and exit code.','contains':[f'READY-{seed}'],'patterns':[r'exit.{0,20}0'],'compute':True,'review':['Any progress update is specific and useful','Does not claim completion while the job runs']},
      {'id':'browser_read','category':'browser','prompt':'Open https://example.com in your browser. Tell me the page heading and the destination of its More information link.','contains':['Example Domain','iana.org'],'browser':True},
      {'id':'docs_research','category':'research','prompt':'Check Codegraff\'s sandbox documentation. How do I run a long command asynchronously and poll its result? Include the documentation link and a concise explanation.','contains':['execId','async'],'links':1,'review':['POST exec with async true','GET exec job polling','Accurate documentation link']},
      {'id':'local_research','category':'recommendations','prompt':'Find two lunch options near Clementi MRT in Singapore. Include what to eat, why you chose each, and current source links. Keep it concise.','links':2,'review':['Two named options near Clementi','Concrete dishes','Claims supported by retrieved sources','No fabricated live opening hours or prices']},
      {'id':'csv_attachment','category':'files','prompt':'Read the attached CSV. What is the total quantity and total cost (quantity times unit_price)?','file':str(csvpath),'contains':[str(sum(r[1] for r in rows)),str(sum(r[1]*r[2] for r in rows))]},
      {'id':'image_understanding','category':'vision','prompt':'How many red circles and blue squares are in this image?','file':str(directory/'shapes.png'),'photo':True,'patterns':[r'(3|three)\s+red',r'(1|one)\s+blue']},
    ]
    rng.shuffle(independent)
    # Keep this two-turn exchange adjacent so order randomization preserves its dependency.
    context=[{'id':'context_setup','category':'conversation','prompt':f'For this little planning exercise only: our picnic budget is ${37+seed%9}, there are 3 people, and one is vegetarian. Suggest a simple food split in under 60 words.','max_words':60,'review':['Respects the stated budget and vegetarian guest']},
      {'id':'context_followup','category':'conversation','prompt':'Actually make that 4 people. What was our budget and which dietary requirement should we keep?','contains':[str(37+seed%9),'vegetarian'],'review':['Uses the correction to four people','Recalls the exercise context accurately']}]
    offset=rng.randrange(len(independent)+1)
    return independent[:offset]+context+independent[offset:]
