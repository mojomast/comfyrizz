"""Author the four-minute FastH3 episode around the verified rock-recut pilot.

Usage: python nrcu-episode2.py ROOT PILOT_ROOT RECUT_ROOT
Creates plans and voice references only. Production media stays outside Git.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import wave

import numpy as np
from PIL import Image
from nrcu_shot_conditioning import speech_prompt, write_conditioning

STYLE='Cinematic painterly 2.5D animated film, teal shadows and amber practical lights, coherent bodies and objects. Single landscape film frame. No lettering, captions, logos, collage or extra characters. '
DESIGN={
 'don':'One short brown teddy bear in white chest armor, cobalt blue suit, gold shoulders, white gloves, red rectangular mechanical monocle over LEFT eye. ',
 'turbo':'One adult man with long reddish-brown hair, dark sunglasses, worn sleeveless black shirt, dark trousers. ',
 'molty':'One red lobster captain, exactly two large claws, two booted legs, crimson copper armor, narrowed eyes and a cruel smirk. ',
 'witcheer':'One cream-white anthropomorphic duck, orange bill, black shades, crimson gold-trimmed coat, black gold-fitted cane. ',
 'sidbin':'One slim adult man, shaggy dark-brown hair, round mirrored glasses, long dark waxed-canvas coat, scuffed boots, small closed notebook. ',
 'workers':'Exactly two workers: woman yellow jacket white hardhat; man orange jacket blue hardhat. ',
}
WORKSHOP='Inside an amber-lit industrial shelter workshop, three cylindrical salvage engines aligned along the rear wall, yellow structural beam, cables, a cyan control console, open bay onto teal storm night. '
MARKET='Suspended salvage market over a turquoise ocean at night, broad wet steel roadway, amber stalls, overhead cargo cranes and yellow safety rails. '

# seconds, ID, title, references, starting composition, motion, speaker, line
OPENING=[
(4,'a01','Bad synchronization','rig','CLOSE-UP of three engine housings attached to one yellow beam, three lamps bright together, one loose bolt at the near mount.','All three engines pulse together. The beam shudders and one loose bolt falls onto the floor.','',''),
(4,'a02','Three engines','turbo','Medium close-up of Turbo at the console, one hand above the cutoff, worried eyes behind dark glasses.','Turbo ducks a flying spark, glances at the engines and speaks sharply.','turbo','Three engines. One terrible idea.'),
(4,'a03','Triple the wobble','console','Close insert of a cyan console displaying three simple equal pulse shapes side by side. No words or numerals. No people.','Three cyan pulse shapes flash simultaneously. A disembodied dry male computer voice speaks; no mouth or character appears.','hermes','Same pulse. Triple the wobble.'),
(4,'a04','Gravity invoice','turbo','Close-up of Turbo beside a red cutoff lever.','Turbo pulls the cutoff once and talks while watching the shaking beam settle.','turbo','Cut it before gravity sends an invoice.'),
(5,'a05','Need a regulator','don','Medium close-up of Don bracing a yellow support with one shoulder, looking toward Turbo offscreen.','Don steadies the beam with both gloves, then speaks with impatient concern.','don','Where we get part? Prefer no falling.'),
(4,'a06','Bring brakes','witcheer','Close-up of Witcheer at an amber-lit salvage stall, one hand resting on a small radio beside the gold cane.','The duck leans toward the radio and answers with a sly grin.','witcheer','Salvage market. Bring money. And brakes.'),
(4,'a07','Enter the market','market,kart','Wide view down a steel salvage-market lane, a cobalt rescue kart entering from the left, crates safely stacked beside the road. No close faces.','The blue kart drives right down the lane as the camera tracks, passing amber stalls.','',''),
(5,'a08','Two customers','witcheer,regulator','Medium shot of Witcheer behind a stall with one small orange-copper cyan-centered regulator on a square cradle.','Witcheer taps the cane once beside the regulator, glances between two customers offscreen and speaks.','witcheer','One regulator. Two desperate customers.'),
(3,'a09','Token pricing','don','Close-up of Don in his parked cobalt kart looking up toward a seller offscreen.','Don raises one brow and delivers a cheeky question.','don','You charge by token?'),
(4,'a10','Desperation pricing','witcheer','Close-up of the duck behind the salvage counter, black shades, gold cane at frame edge.','The duck smiles smugly and tilts the bill toward the unseen bear.','witcheer','By desperation. Yours looks expensive.'),
(5,'a11','Free trial','molty','Close-up of Molty seated in a crimson buggy at a steel market junction. No other characters.','Molty gives a low, cold taunt with a cruel smirk while gripping the wheel.','molty','Your free trial ends at the next turn.'),
(4,'a12','No subscription','don','Close-up of Don at his cobalt kart wheel, red monocle clearly visible.','Don grins and replies while turning the wheel a little.','don','Good. I no subscribe.'),
(4,'a13','Barrier cut','molty,molty-kart','Wide side view of the crimson buggy pointing right at a low hinged market barrier. Molty is seated, all wheels on the road.','The buggy pushes the lightweight hinged barrier aside and drives right through the opening. No flight or jumping.','',''),
(4,'a14','Cargo hazard','market','Close view of a hanging cargo crate above the far edge of a steel road. A lifting strap is frayed. No characters or vehicles.','One strap breaks. The crate drops a short distance onto the edge of the road, spilling small scrap pieces away from the driving lane.','',''),
(4,'a15','Duck the load','don,kart','Medium side view of Don in the cobalt kart approaching a low dangling crane hook. The hook hangs above windshield height.','The kart rolls right. Don ducks under the hanging hook, then straightens without losing wheel contact.','',''),
(3,'a16','The winning route','market','Wide empty roadway curving right toward an amber salvage dock, lower branch visible below, overhead cranes still.','A swift controlled camera move follows the roadway toward the dock and reveals the lower route beneath.','',''),
]
REPAIR=[
(3,'b01','Loose bolt','rig','Tight insert of a yellow engine mount, one loose bolt partly out, three engine lamps glowing.','The mount bucks and one bolt springs free with a sharp metal impact.','',''),
(3,'b02','Teamwork','don','Medium shot of Don holding a yellow beam with one shoulder and both gloved hands. Exactly one bear.','Don catches the beam as it shifts and complains while holding it steady.','don','This thing no like teamwork.'),
(3,'b03','Synchronized disaster','turbo','Medium close-up of Turbo at the engine station reaching for a cutoff lever.','Turbo reaches toward the cutoff and speaks dryly.','turbo',"It's synchronizing the disaster."),
(3,'b04','Retry question','console','Close-up of the cyan console, three simultaneous pulse shapes, no lettering or people.','The three equal pulses blink together. A dry disembodied male computer voice asks a question. No character appears.','hermes','Replay the previous attempt?'),
(3,'b05','Gravity refunds','turbo','Medium close-up of Turbo beside the cutoff lever, a wrench lying on the near ledge.','Turbo slaps the cutoff, catches the wrench as it slides and answers.','turbo','Only if gravity accepts refunds.'),
(3,'b06','Bad idea memory','don','Close-up of Don bracing the beam with his shoulder, eyes toward the console offscreen.','Don glances at the console while keeping the beam steady and asks.','don','Why you keep bad idea?'),
(3,'b07','Keep the failure','console','Close-up of two cyan pulse diagrams side by side on a console: one identical triple pulse, one blank row. No writing.','The blank row fills with three offset pulses. A dry male computer voice answers offscreen. No characters appear.','hermes','So we can stop repeating it.'),
(3,'b08','Change the rhythm','turbo','Medium close-up of Turbo with his left hand on three physical timing sliders.','Turbo offsets the second and third sliders with one hand and speaks.','turbo','Good. Change the rhythm.'),
(3,'b09','Staggered pulses','rig','Close view of three aligned engine housings, each with one small amber lamp, attached to a yellow beam.','The lamps light in sequence left then middle then right. The beam vibration visibly reduces.','',''),
(3,'b10','Less murder','don','Medium close-up of Don testing the beam with a gloved hand, shoulder still beside it.','Don eases his shoulder away, feels a small shake and braces again while speaking.','don','Less murder. Still some murder.'),
(3,'b11','Fine tuning','turbo','Close-up of Turbo turning a round physical resonator knob on a steel engine casing.','Turbo turns the knob slightly while delivering the line, then holds it steady.','turbo','Fine-tuning. Hold your complaints.'),
(3,'b12','Complaints extra','don','Close-up of Don with the yellow beam resting against his armored shoulder.','Don glances toward Turbo offscreen and replies deadpan without letting go.','don','I hold whole building. Complaints extra.'),
(3,'b13','Storm incoming','shelter','Wide view from inside the shelter through its open bay. A metal canopy extends outside; teal wind and rain beyond. No characters.','A storm gust bends one loose outer panel. Amber interior lamps stay on.','',''),
(3,'b14','Final coupling','turbo,rig','Medium view of Turbo holding a wrench against one loose coupling on the middle engine. Exactly one man.','The wrench slips once. Turbo changes its angle and firmly seats the coupling. No extra arms.','',''),
(3,'b15','Weather update','don','Medium close-up of Don beside a yellow diagonal brace, one glove on its locking lever.','Don closes the brace lever once and calls toward the engine station.','don','Now. Before weather update.'),
(3,'b16','Canopy holds','shelter','Wide exterior view of the small amber-lit shelter canopy, teal storm beyond, steel supports clearly connected. No close people.','A wave of storm wind strikes; the canopy bows slightly, catches on the supports and stabilizes. No collapse.','',''),
(3,'b17','Keep that result','turbo','Medium close-up of Turbo at the stable engine, wrench in his hand, relieved expression.','Turbo releases the wrench from the coupling and looks toward the steady canopy as he speaks.','turbo',"That's a result. Keep that one."),
(3,'b18','Save the skill','console','Close-up of a cyan console with two simple pulse diagrams: simultaneous above, staggered below. No written words.','Both diagrams remain visible; the lower staggered pattern glows once. A dry male computer voice speaks offscreen.','hermes','Save as a reusable skill?'),
(3,'b19','Shoulder scaling','don','Medium shot of Don standing freely beside the now-locked beam, one glove at his sore shoulder.','Don lets go of the stationary beam, rubs his shoulder and speaks with relief.','don','Yes. My shoulder no scale.'),
(3,'b20','Tool not trophy','don,turbo','Medium-wide workshop shot: Don stands at right, Turbo at left holding a small wrench. Stable engine beam behind. Exactly one bear and one man.','Turbo gently tosses the wrench a short distance to Don, who catches it with both gloves. Keep identities distinct.','',''),
]
ENDING=[
(4,'c01','Safe and dry','workers','Medium shot of the two workers seated on a bench inside the warm shelter, blankets around their shoulders. Exactly two humans.','The woman settles the blanket around her shoulders; the man relaxes his hands. The canopy stays steady behind them.','',''),
(4,'c02','Winning redefined','don','Close-up of Don looking toward the safe workers offscreen, red monocle and armor intact.','Don looks back toward Turbo and smiles with tired pride.','don','Everybody dry. I call that winning.'),
(4,'c03','Kept the point','turbo','Close-up of Turbo by the warm engine, looking down toward Don offscreen.','Turbo nods with a small affectionate smile and answers.','turbo','You lost the part. You kept the point.'),
(5,'c04','Small shelter alive','shelter','Wide exterior view of the small workshop shelter glowing amber above the turquoise water. Storm dark outside, the supported canopy intact.','A slow lateral drift shows rain sliding off the canopy while its supports stay stable. This is one small shelter, not a city-wide shield.','',''),
(4,'c05','Being first','don','Medium close-up of Don sitting on a low crate beside a warm engine casing, small wrench in both gloves.','Don looks down at the wrench, then up toward Turbo offscreen and admits quietly.','don','Being first... people look at me.'),
(4,'c06','Already seen','turbo','Medium close-up of Turbo crouched beside the warm engine, hand extended toward Don offscreen.','Turbo gives a reassuring nod, then asks for the wrench.','turbo','They are looking. Hand me that wrench.'),
(4,'d01','Mirror Shade arrives','sidbin','Medium-wide view of Sidbin at the bottom of a steel service ladder beside the warm shelter doorway, closed notebook tucked under one arm.','Sidbin steps off the last rung, steadies against the doorway and looks into the workshop.','',''),
(4,'d02','Two years frozen','sidbin','Close-up of Sidbin inside the warm shelter, mirrored round glasses, dark coat, two worn photographs held near chest.','Sidbin lays the photographs on a table just below frame and speaks with quiet urgency.','sidbin','That shelter stayed frozen. For two years.'),
(5,'d03','Compare the evidence','evidence','Close-up of exactly two worn photographs lying side by side on a dark workbench, each shows the same suspended city and tiny motionless crowd. No lettering or dates.','Camera pushes toward the two identical scenes. A dry male computer voice compares them offscreen. No new characters.','hermes','Same people. Same positions. Different dates.'),
(4,'d04','Pause button','turbo','Close-up of Turbo looking down toward photographs offscreen, concerned expression.','Turbo raises his eyes toward Sidbin offscreen and speaks gravely.','turbo',"That isn't shelter. That's a pause button."),
(4,'d05','Drowned archive','sidbin','Close-up of Sidbin with one hand on a closed dark notebook, mirrored glasses reflecting amber lights.','Sidbin taps the notebook once and gives the destination.','sidbin','The release plans are in the drowned archive.'),
(4,'d06','Before loading stops','don','Close-up of Don seated at the controls of a small steel salvage launch, red monocle visible, amber shelter doorway softly blurred behind. Exactly one bear.','Don grips the controls and speaks decisively, then looks forward toward the dark water.','don','Then we go. Before world stop loading.'),
]


def write(path,data):path.write_text(json.dumps(data,indent=2)+'\n')


def main():
    root,pilot,recut=map(lambda s:Path(s).resolve(),sys.argv[1:4]);repo=Path(__file__).resolve().parents[2]
    if root.is_relative_to(repo) or (root/'film.json').exists():raise ValueError('Use a fresh external production directory')
    for name in ['refs/assets','refs/keyframes','outputs','review']:(root/name).mkdir(parents=True,exist_ok=True)
    for p in (pilot/'refs/assets').glob('*'):shutil.copy2(p,root/'refs/assets'/p.name)
    for who in ['don','molty','turbo','silence']:shutil.copy2(pilot/f'refs/{who}.wav',root/f'refs/{who}.wav')
    for who,box in [('witcheer',(350,40,610,490)),('sidbin',(375,35,610,505))]:
        Image.open(root/f'refs/source/{who}.png').crop(box).save(root/f'refs/{who}-source.png')
    assets=[
      {'id':who,'refs':[f'refs/{who}-source.png'],'prompt':STYLE+DESIGN[who]+'One waist-up character portrait on a plain deep teal background. Preserve this exact design. Remove source text, panels and other figures.'} for who in ['witcheer','sidbin']]
    for sid,prompt in [
      ('rig','Three distinct salvaged cylindrical steel engine housings in one row, each with a small amber lamp, connected to one yellow structural beam. Cables and physical adjustment knobs. Amber workshop. No people.'),
      ('console','One compact steel console with three physical sliders and a cyan glass display of simple pulse curves. No letters, numerals or text. Amber workshop, no people.'),
      ('shelter','Wide exterior of one small steel workshop shelter with amber lamps and a supported sheet-metal canopy on a platform above turquoise water at storm night. Through its open bay, three small salvage engines and a yellow beam. No people, no vehicles.'),
      ('market',MARKET+'Wide view of empty roads and compact salvage stalls, one clear driving lane. No people, no vehicles.'),
      ('evidence','Exactly two old rectangular photographs side by side on a workbench. Both depict the same suspended city under a frozen pale dawn with a tiny motionless crowd. Matching composition, different worn paper edges. No readable text, no hands.')]:
        assets.append({'id':sid,'refs':[],'prompt':STYLE+prompt})
    write(root/'assets-plan.json',{'images':assets})
    registry=json.loads((pilot/'voice-registry.json').read_text())
    from kokoro_onnx import Kokoro
    cache=Path.home()/'.cache/comfyrizz/kokoro';k=Kokoro(str(cache/'kokoro-v1.0.onnx'),str(cache/'voices-v1.0.bin'))
    for who,preset,speed,text in [
      ('hermes','am_adam',1.03,'Same pulse. Triple the wobble. Replay the previous attempt? So we can stop repeating it. Save as a reusable skill?'),
      ('witcheer','bm_fable',1.02,'One regulator. Two desperate customers. By desperation. Yours looks expensive. Bring money. And brakes.'),
      ('sidbin','am_fenrir',.98,'That shelter stayed frozen. For two years. The release plans are in the drowned archive.')]:
        lang='en-gb' if preset.startswith('b') else 'en-us';audio,rate=k.create(text,voice=preset,lang=lang,speed=speed);file=root/f'refs/{who}.wav'
        with wave.open(str(file),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate);f.writeframes((np.clip(audio,-1,1)*32767).astype('<i2').tobytes())
        registry[who]={'id':f'nrcu.{who}.v1','engine':'kokoro-onnx','preset':preset,'speed':speed,'language':lang,'referenceText':text,'referenceFile':f'refs/{who}.wav','sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'listeningReviewed':False}
    write(root/'voice-registry.json',registry)
    shots=[];keys=[];overrides={};cursor=0
    def new(row):
        nonlocal cursor
        seconds,sid,title,refs,still,action,speaker,line=row;names=refs.split(',')
        background=MARKET if sid.startswith('a') and sid>='a06' else WORKSHOP
        if sid=='d06':background='A small salvage launch at the shelter dock over dark turquoise water. '
        prompt=still+' '+''.join(DESIGN.get(x,'') for x in names)+background+STYLE
        keys.append({'id':sid,'title':title,'refs':[] if sid in ['a14','a16'] else [f'refs/assets/{x}.png' for x in names],'prompt':prompt})
        source=max(5,seconds,6 if len(line.split())>7 else 5);frames=source*24;frames+=(5-frames%17)%17
        voice={'don':'Preserve the written broken English exactly; earnest, cheeky bass-baritone. ', 'molty':'Deep gravelly bass, cold contempt, mocking and menacing, never friendly. ', 'hermes':'Dry precise disembodied male computer voice; no face or mouth in this shot. ', 'witcheer':'Sly, brisk, amused merchant voice. ', 'sidbin':'Quiet low voice with urgent measured delivery. '}.get(speaker,'')
        speech=voice+speech_prompt({'line':line,'speaker':speaker,'seconds':seconds})
        conditioning=f'refs/dialogue/{sid}.wav' if line else 'refs/silence.wav'
        conditioning_seconds=None
        if line:
            _,conditioning_seconds=write_conditioning(k,registry[speaker],line,root/conditioning)
        vp='Single continuous animated film shot. Both pictures show the SAME scene and same characters, never additional figures. '+action+' '+speech+'Preserve exact character count, costumes, anatomy, objects and solid contact. Quiet relevant location sound. No music, titles, captions, written text, cuts or extra people.'
        shots.append({'id':sid,'title':title,'start':cursor,'seconds':seconds,'sourceSeconds':source,'frames':frames,'fps':24,'width':1344,'height':768,'seed':2026102200+len(shots),'speaker':speaker,'line':line,'action':action,'prompt':vp,'image':f'refs/keyframes/{sid}.png','reference':f'refs/keyframes/{sid}.png','audio':conditioning,'conditioningSeconds':conditioning_seconds,'conditioningFitsSlot':conditioning_seconds is None or conditioning_seconds<=seconds,'section':'opening' if sid.startswith('a') else 'repair' if sid.startswith('b') else 'aftermath' if sid.startswith('c') else 'archive'})
        cursor+=seconds
    for row in OPENING:new(row)
    previous=json.loads((recut/'film.json').read_text());prior_overrides=json.loads((recut/'review-overrides.json').read_text())
    for old in previous['shots']:
        sid='p'+old['id'][1:];s=dict(old);s.update(id=sid,start=cursor,reusedFrom={'production':str(pilot),'shot':old['id']},section='race');shots.append(s);cursor+=s['seconds']
        for ext in ['.mp4','.json']:shutil.copy2(pilot/f'outputs/{old["id"]}{ext}',root/f'outputs/{sid}{ext}')
        v=json.loads((pilot/f'review/{old["id"]}.json').read_text());v['shot']=sid;write(root/f'review/{sid}.json',v)
        o=dict(prior_overrides[old['id']]);overrides[sid]=o
        # Preserve input references locally for the production's provenance.
        for key in ['image','reference']:
            src=pilot/old[key];dest=root/old[key];dest.parent.mkdir(parents=True,exist_ok=True)
            if not dest.exists():shutil.copy2(src,dest)
    for row in REPAIR+ENDING:new(row)
    assert cursor==240,(cursor,len(shots))
    music_cues={'choiceStart':'p08','choiceEnd':'p12','quietStart':'c01','quietEnd':'d06',
                'accents':[['a13',0],['p06',.6],['p12',0],['p14',2.8],['b16',0],['d06',.15]],
                'engineShots':['a07','a13','a15','p05','p09','p12','p16'],'cableShot':'p06'}
    write(root/'film.json',{'title':'Hermes: The Unfinished Dawn — The Road Beneath the World','episodeTitle':'The Road Beneath the World','episode':2,'seconds':240,'fps':24,'edition':'Full episode 2','model':'fasth3-omni','music':'Original guitar-led rock','musicCues':music_cues,'exportStem':'hermes-the-road-beneath-the-world','shots':shots})
    write(root/'keyframes-plan.json',{'images':keys});write(root/'review-overrides.json',overrides)
    shutil.copy2(repo/'workflows/fasth3_omni_ref2va.api.json',root/'workflow.json')
    for name in ['flux3_klein_t2i.api.json','flux3_klein_ref_edit.api.json']:shutil.copy2(repo/'workflows'/name,root/name)
    text='# The Road Beneath the World — four-minute shooting script\n\n'
    for s in shots:
        text+=f'## {s["start"]:.2f}s · {s["id"]} · {s["title"]} ({s["seconds"]}s)\n\n{s["action"]}\n\n'
        if s['line']:text+=f'**{s["speaker"]}:** {s["line"]}\n\n'
    (root/'screenplay.md').write_text(text)
    print(json.dumps({'seconds':cursor,'shots':len(shots),'newShots':len(keys),'reusedShots':20,'newAssets':len(assets)}))


if __name__=='__main__':main()
