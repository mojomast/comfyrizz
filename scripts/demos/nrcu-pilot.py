"""Author the 90-second NRCU pilot and persistent synthetic voice references.

Usage: python nrcu-pilot.py PRODUCTION_DIRECTORY
Source archive images must already be under refs/source/{don,turbo}.png.
No metered inference happens here. Video jobs use native FastH3 Omni exclusively.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import wave

import numpy as np
from PIL import Image

STYLE = ('Cinematic stylized animated superhero film, painterly 2.5D anime, clean strong silhouettes, '
         'physically coherent solid bodies, expressive faces, detailed metal and cloth, dramatic teal '
         'storm-night light with amber practical lights, restrained film grain, premium feature-animation '
         'composition. No text, typography, panels, logos, watermark, split screen or collage. ')
WORLD = ('A suspended industrial salvage rail above a luminous turquoise ocean beneath a broken orbital ring. '
         'A wide steel upper roadway goes from screen left toward screen right to an amber-lit salvage dock. '
         'A sloping lower branch leads down to a damaged worker platform. Rust steel trusses, yellow railings, '
         'wet metal, teal night clouds, distant amber city lights. The vehicles have solid wheels on roadway. ')
DON = ('Don Piedro, one short brown teddy-bear hero with round ears, short fur, white chest armor over cobalt '
       'blue clothing, gold shoulder details, white gloves, a red rectangular mechanical monocle over his LEFT '
       'eye. He has a bear muzzle, not a human face. Compact powerful build. ')
MOLTY = ('Molty, one anthropomorphic red lobster rescue captain with two expressive black eyes, short antennae, '
         'exactly two large red claw arms and two booted legs, segmented crimson and copper rescue armor, '
         'dark undersuit. Clearly a lobster head with no human face. ')
TURBO = ('Turbo Fit, one lean adult man with long wavy reddish-brown hair, dark sunglasses, sleeveless worn '
         'black shirt, dark tactical trousers, leather wrist cuffs. ')
WORKERS = ('Exactly two adult human workers: a woman in a yellow work jacket and white hard hat, and a man '
           'in a rust-orange work jacket and blue hard hat. Both wear gray trousers and work gloves. ')
KART = ('A low four-wheeled cobalt-blue rescue kart with a white wedge nose, gold edge stripe, black tires, '
        'one open driver seat and a flat rear rescue platform with yellow guardrails. ')
CORE = ('One compact orange-copper cylindrical power regulator with a bright cyan circular center, two '
        'dark carrying handles and a square black mounting base. ')

# Editor timings sum to 90 seconds. Generated takes have at least five seconds
# of source handles; the edit preserves measured dialogue rather than speeding it.
SHOTS = [
 (5,'world','The two routes',['world','kart'],'A very wide high-angle view clearly shows the upper road to the amber dock and the lower branch to a small damaged work platform. A cobalt kart travels along the upper road from left to right. No close-up faces.','A slow forward aerial drift reveals the two vertically separated routes; the small cobalt kart moves left to right.','',''),
 (4,'prop','The prize',['regulator','world'],'Close low-angle view of the orange-copper regulator secured in its square cradle at the amber-lit upper dock. The upper road leads toward it. No people.','A controlled slow push toward the regulator; cyan light pulses once. The regulator stays seated in its cradle.','',''),
 (5,'don','First place',['don','kart','world'],'Medium close-up of Don sitting in the single driver seat of his cobalt kart. Both gloved hands on the wheel. Teal wind and passing yellow railing behind him. No passengers.','Tracking medium close-up. Don leans forward with a proud grin while driving steadily.','don','You watch me. This time, I first.'),
  (5,'molty','The rival',['molty','molty-kart','world'],'Medium close-up of Molty driving a crimson wheeled cargo buggy with a dark rear equipment cage. Claws on steering controls. They glance left toward the unseen rival.','Tracking medium close-up. Molty gives the rival a cold mocking sneer, then faces the road.','molty','Keep up, little bear. That regulator belongs to me.'),
 (4,'race','Side by side',['don','molty','world'],'Wide side view of a cobalt kart and a crimson cargo buggy racing side by side from left to right along one broad steel road. Don drives cobalt; red lobster Molty drives crimson. Ocean far below.','Lateral tracking camera follows two grounded vehicles racing left to right; wheels turn and spray rises. Keep both drivers seated.','',''),
 (5,'world','The broken support',['world'],'Close view underneath the LOWER worker platform. A corroded steel support cable is visibly frayed at its anchor. Yellow railing above, turquoise ocean far below. No people in this close view.','The frayed support cable snaps; one loose end recoils and the lower platform tilts slightly. Small sparks and debris fall.','',''),
 (5,'workers','People below',['workers','world'],'Medium-wide view of exactly two workers stranded on the lower platform, gripping yellow railing as the floor slopes. The main road is clearly above and behind them. No other people.','The floor tilts a few degrees; both workers grip the railing and steady their feet. The woman reaches toward the upper roadway. No falling bodies.','',''),
 (4,'don','The choice',['don','kart','world'],'Tight close-up of Don in his kart, eyes angled DOWN toward the endangered workers offscreen. Determination replaces his grin. No other characters.','Don looks down and his grin disappears. His gloved hands tighten on the steering wheel. A short decisive reaction, camera steady.','',''),
 (5,'don','Brake at the fork',['don','kart','world'],'High three-quarter view of the cobalt kart at a clear fork: upper road continues to screen right, lower ramp descends toward bottom right. Don is driving. No passengers.','Don brakes before the fork, tires throw a small spray; he turns the wheel toward the lower ramp. The kart stays on the solid roadway.','',''),
  (5,'molty','The ultimatum',['molty','molty-kart','world'],'Close-up of Molty in the crimson buggy, one claw beside a small shoulder radio, narrowed eyes and a cruel smirk. Their vehicle is stopped at the upper fork.','Molty speaks into the shoulder radio with cold contempt, treating the rescue as a chance to seize the regulator.','molty','Take the lower road. The regulator is mine.'),
 (5,'don','Go',['don','kart','world'],'Close-up of Don seated in his cobalt kart at the lower ramp entrance, briefly glancing up toward Molty offscreen. No other characters.','Don gives one firm nod toward the upper roadway, speaks, then faces the descent.','don','I go lower. You take core. People need you.'),
 (4,'don','The descent',['don','kart','world'],'Wide side view of the cobalt kart descending a steel ramp left to right toward the damaged lower work platform. Don is the sole driver. Empty rescue platform at the rear.','The kart drives DOWN the solid ramp from left to right, then slows beside the lower platform. Clear wheel contact, no jumping or flying.','',''),
 (5,'rescue','Make a crossing',['don','workers','world'],'Medium-wide view: Don stands beside his parked cobalt kart, its flat rear rescue platform alongside the damaged workers platform. A short metal gangplank bridges the narrow gap. The two workers wait at the far end.','Don braces the near end of the metal gangplank with both gloved hands. The woman in yellow cautiously places one foot onto the far end while the man waits behind her. No teleporting, no extra people.','',''),
 (5,'rescue','Passengers aboard',['don','workers','kart'],'Medium side view: Don stands beside his parked cobalt kart. The woman in yellow is already seated inside the rear rescue platform; the man in rust stands on the gangplank beside its entrance. Yellow guardrails.','The man in rust takes one measured step from the gangplank into the kart rear platform and sits beside the woman. Don holds the guardrail steady. Exactly one bear and two workers.','',''),
 (4,'molty','The regulator won',['molty','regulator','world'],'Medium shot of Molty at the amber-lit upper salvage dock, both claws already securely gripping the handles of the orange-copper regulator. A crimson cargo buggy with an empty rear cage is beside them.','Molty lifts the single regulator a short distance and lowers it into the open cargo cage. The cyan center remains visible. No extra regulators.','',''),
 (3,'molty','The cost',['molty','molty-kart','regulator'],'Rear three-quarter view of the crimson cargo buggy carrying the orange-copper regulator visibly in its rear cage, on the upper roadway toward the far amber district. Molty drives.','The crimson buggy drives away to screen right carrying the regulator. The blue rival kart is absent from the upper road.','',''),
 (6,'turbo','Empty handed',['turbo','world'],'Medium close-up of Turbo in the shelter workshop at the end of the salvage route: rust girders, warm hanging lamps, teal storm visible through the open bay. He looks at an arriving kart offscreen.','Turbo steps toward the arriving rescue, looks for the missing equipment, and asks with worried disappointment.','turbo','Where is the regulator? We needed that part.'),
 (6,'don','Everybody here',['don','workers','world'],'Medium close-up of Don beside his parked cobalt rescue kart in the warm shelter workshop. Both rescued workers are safely seated behind yellow rear guardrails, softly out of focus. Don faces Turbo offscreen.','Don looks up, briefly ashamed, then glances toward his two safe passengers and speaks earnestly. Keep the passengers silent.','don','We no get part. But everybody here.'),
 (3,'turbo','Get them warm',['turbo','world'],'Close-up of Turbo in the warm shelter workshop, long reddish hair and dark sunglasses, his disappointed expression softening as he notices the rescued passengers offscreen.','Turbo exhales, nods gently toward the passengers, and speaks warmly.','turbo',"All right. Let's get them warm."),
 (2,'rescue','What winning means',['don','workers','kart'],'Medium detail shot inside the parked rescue platform: Don gently checks the yellow safety strap across the seated woman in yellow. She is safe; the man in rust sits beside her. Warm shelter lighting.','Don gives the already-fastened safety strap one small reassuring tug, then looks up at the safe passenger. Quiet held reaction.','',''),
]


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n')


def wav(path, audio, rate=24000):
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(rate)
        f.writeframes((np.clip(audio,-1,1)*32767).astype('<i2').tobytes())


def main():
    root = Path(sys.argv[1]).resolve()
    repo = Path(__file__).resolve().parents[2]
    if root.is_relative_to(repo):
        raise ValueError('Keep media outside Git')
    if (root/'film.json').exists():
        raise ValueError('Production already authored; preserve its reviewed plans and voice registry. Use a fresh directory for a new production.')
    refs = root/'refs'; (refs/'assets').mkdir(exist_ok=True, parents=True)
    Image.open(refs/'source/don.png').crop((365,455,1135,1225)).save(refs/'don-source.png')
    Image.open(refs/'source/turbo.png').crop((608,40,818,498)).save(refs/'turbo-source.png')
    assets = [
      {'id':'don','refs':['refs/don-source.png'],'prompt':STYLE+DON+'Clean heroic waist-up character portrait, relaxed closed mouth, complete shoulders, plain deep teal background. Preserve the supplied bear armor and red eye-piece design. Remove source lettering, other figures, laser beam, blood and scratches. Exactly one bear.'},
      {'id':'molty','refs':[],'prompt':STYLE+MOLTY+'Clean waist-up character portrait, both broad claw hands visible at waist, confident friendly eyes, plain deep teal background. Original lobster superhero rescue captain design. Exactly one lobster.'},
      {'id':'turbo','refs':['refs/turbo-source.png'],'prompt':STYLE+TURBO+'Waist-up portrait of this exact man, plain deep teal background, closed mouth, both shoulders visible. Preserve hair, dark glasses and worn sleeveless shirt. No instrument, no text, exactly one man.'},
      {'id':'world','refs':[],'prompt':STYLE+WORLD+'Very wide establishing view of the fork with upper salvage dock and lower worker platform. Empty scene: no people, no vehicles. Wide aspect ratio.'},
      {'id':'regulator','refs':[],'prompt':STYLE+CORE+'Prop design photograph at three-quarter angle, seated on its cradle at an amber-lit metal workbench. No people, no lettering. The cyan center makes this exact prop unmistakable.'},
      {'id':'workers','refs':[],'prompt':STYLE+WORKERS+'Medium full-body view standing side by side, faces clearly visible, plain dark teal background. Exactly two people, no tools or extra figures.'},
      {'id':'kart','refs':[],'prompt':STYLE+KART+'Three-quarter vehicle view on a metal workshop floor, clear coherent four-wheel design, empty driver seat and empty rear platform. No people.'},
      {'id':'molty-kart','refs':[],'prompt':STYLE+'A crimson four-wheeled cargo buggy, broad black tires, copper armored nose, single open driver seat and square black metal rear equipment cage. Three-quarter view on workshop floor. Empty vehicle, no people, no lettering.'},
    ]
    write(root/'assets-plan.json',{'images':assets})
    keyframes=[];shots=[];cursor=0
    for i,(seconds,kind,title,images,still,action,speaker,line) in enumerate(SHOTS,1):
        sid=f's{i:02}'
        descriptions=' '.join({'don':DON,'molty':MOLTY,'turbo':TURBO,'workers':WORKERS,'kart':KART,'regulator':CORE}.get(a,'') for a in images)
        keyframes.append({'id':sid,'refs':[f'refs/assets/{a}.png' for a in images],
                          'prompt':STYLE+descriptions+WORLD+still+' This is a single film frame, not a reference sheet. Preserve the supplied character and prop designs.'})
        source_seconds=max(5,seconds)
        frames=source_seconds*24;frames+=(5-frames%17)%17
        speech=(f'Use <Audio 1> only for the voice identity. The only spoken words are exactly: "{line}". '
                'Preserve the written grammar exactly, including missing articles and nonstandard English. '
                f'Start speaking at 0.25 seconds and finish before {source_seconds-.5} seconds. '
                'Then close the mouth and stay silent; do not add another word. ' if line else
                'No speech, no narration, no vocalizations. Keep mouths closed. Only natural action sounds. ')
        identity={'don':'don','molty':'molty','turbo':'turbo','rescue':'don','workers':'workers','race':'don','prop':'regulator','world':'world'}[kind]
        voice_direction=('Low resonant antagonist voice, gravelly edge, cold contempt and controlled menace. Never friendly or cheerful. ' if speaker=='molty' else '')
        prompt=('Single continuous animated film shot. <Picture 1> is the exact scene composition and starting state. '
                '<Picture 2> is a design reference only, not an additional figure to insert. '
                'Animate the scene as one continuous shot. '+action+' '+voice_direction+speech+
                'Sound: cinematic but restrained location ambience and precisely relevant Foley. '
                'No music, no subtitles, no titles, no cuts, no duplicate bodies. Preserve costume and object count.')
        shots.append({'id':sid,'title':title,'speaker':speaker,'line':line,'action':action,'kind':kind,
                      'start':cursor,'seconds':seconds,'sourceSeconds':source_seconds,'frames':frames,'fps':24,
                      'width':1344,'height':768,'seed':2026102100+i,'prompt':prompt,
                      'image':f'refs/keyframes/{sid}.png','reference':f'refs/assets/{identity}.png',
                      'audio':f'refs/{speaker or "silence"}.wav'})
        cursor+=seconds
    assert cursor==90
    write(root/'keyframes-plan.json',{'images':keyframes})
    write(root/'film.json',{'title':'Hermes: The Unfinished Dawn — The Lower Road','seconds':90,'fps':24,
                          'model':'fasth3-omni','shots':shots,'donSpeech':'Broken English, as requested; original synthetic voice.'})
    shutil.copy2(repo/'workflows/fasth3_omni_ref2va.api.json',root/'workflow.json')
    for name in ['flux3_klein_t2i.api.json','flux3_klein_ref_edit.api.json']:
        shutil.copy2(repo/'workflows'/name,root/name)
    text='# The Lower Road — 90-second pilot shooting script\n\n'
    for s in shots:
        text+=f'## {s["start"]:02}s — {s["title"]} ({s["seconds"]}s)\n\n{s["action"]}\n\n'
        if s['line']:text+=f'**{s["speaker"]}:** {s["line"]}\n\n'
    (root/'screenplay.md').write_text(text)
    # These reference performances are original synthesis, never copies of people.
    from kokoro_onnx import Kokoro
    model_dir=Path.home()/'.cache/comfyrizz/kokoro'
    kokoro=Kokoro(str(model_dir/'kokoro-v1.0.onnx'),str(model_dir/'voices-v1.0.bin'))
    voices={'don':('am_michael','en-us',.95,'I no leave you here. You hold tight. We go together. Everybody come home.'),
            'molty':('bm_george','en-gb',.90,'Keep up, little bear. That regulator belongs to me. Take the lower road. I always get what I came for.'),
            'turbo':('bm_lewis','en-gb',.96,'Where is the regulator? We needed that part. All right. Let us get everybody warm.')}
    registry={}
    for who,(voice,lang,speed,text) in voices.items():
        file=refs/f'{who}.wav'
        if not file.exists():
            audio,rate=kokoro.create(text,voice=voice,lang=lang,speed=speed)
            wav(file,audio,rate)
        registry[who]={'id':f'nrcu.{"don-piedro" if who=="don" else "turbofit" if who=="turbo" else who}.v{2 if who=="molty" else 1}',
                       'engine':'kokoro-onnx','preset':voice,'speed':speed,'language':lang,'referenceText':text,
                       'referenceFile':str(file.relative_to(root)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),
                       'use':'FastH3 voice conditioning','listeningReviewed':False}
    wav(refs/'silence.wav',np.zeros(4*24000,dtype=np.float32))
    write(root/'voice-registry.json',registry)
    print(json.dumps({'shots':len(shots),'seconds':cursor,'referenceImages':len(assets),'keyframes':len(keyframes)}))


if __name__=='__main__':
    main()
