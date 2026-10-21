"""Scene-level revision of the NRCU shorts, independent of model clip length.

Each turn changes a decision or relationship. Keep the verified pilot action
sequence; never overwrite its native performance with replacement TTS.
"""

# Line lengths vary deliberately. Turn/reaction timing is measured by the
# preparation script, not guessed from the number of generated frames.
DIALOGUE = {
    'a02': 'Three engines should hold it. Why is it getting worse?',
    'a03': 'They agree on the timing. The beam disagrees.',
    'a04': 'So agreeing faster is the problem. Cut the power.',
    'a05': 'You cut power, I become building. Where we get regulator?',
    'a06': 'My stall. Bring money. We can discuss your structural career.',
    'a08': 'One regulator. Your rival offered cash. What are you offering?',
    'a09': 'Dry people. You charge extra for that?',
    'a10': 'Always. But I might accept a good race.',
    'a11': 'Run along, little hero. I want them watching when you lose.',
    'a12': 'Then watch close. I do best work by accident.',
    'b02': 'We lose part. Now I hold roof. Excellent promotion.',
    'b03': 'The engines work. They just keep making the same mistake.',
    'b04': 'I saved the attempt. Shall I repeat it?',
    'b05': 'Show us. Repeating it nearly killed him.',
    'b06': 'You save mistake? I try forget mine.',
    'b07': 'Forget it and the next attempt starts blind.',
    'b08': 'Keep the evidence. Change the timing.',
    'b10': 'Better. I still no trust it with my head.',
    'b11': 'One more adjustment. Tell me when it stops fighting you.',
    'b12': 'You want report? Roof heavy. Bear expensive.',
    'b15': 'Storm coming. Please finish thinking.',
    'b17': 'It held. Save what changed, not just what worked.',
    'b18': 'A reusable skill. Including the failure?',
    'b19': 'Especially failure. Next bear deserve warning.',
    'c02': 'We lose race. Nobody wet. This count?',
    'c03': 'Ask them. They needed a roof, not a winner.',
    'c05': 'When I win, people see me. When I help, they leave.',
    'c06': 'They get to leave. You gave them that. Stay a minute.',
    'd02': 'I waited two years for that light to move.',
    'd03': 'Different dates. The same faces, in exactly the same positions.',
    'd04': 'The Regent calls that protection. Who gets to wake them?',
    'd05': 'Whoever reaches the drowned archive. The release plans are there.',
    'd06': 'Then we go. This time, nobody wait for winner.',
}

SCENES = [
    {'id': 'diagnosis', 'shots': ['a01','a02','a03','a04','a05','a06'],
     'want': 'Turbo wants control; Don wants the weight off his shoulder.',
     'turn': 'Agreement between the engines is revealed as the cause of failure.',
     'subtext': 'Turbo hides uncertainty behind competence; Don jokes because he is scared.'},
    {'id': 'bargain', 'shots': ['a07','a08','a09','a10'],
     'want': 'Don offers a public good; Witcheer wants a profitable spectacle.',
     'turn': 'The price becomes a race, giving the chase a dramatic cause.',
     'subtext': 'Don wants to believe being useful should be enough.'},
    {'id': 'rivalry', 'shots': ['a11','a12','a13','a14','a15','a16'],
     'want': 'Molty wants public humiliation, not merely the part; Don deflects fear.',
     'turn': 'The race becomes a test of who deserves to be seen.',
     'subtext': 'Molty is a menacing OpenClaw rival, not the Regent; they exploit Don\'s need for recognition.'},
    {'id': 'repair', 'shots': [f'b{i:02}' for i in range(1,21)],
     'want': 'Turbo wants another attempt; Don needs evidence that it will be different.',
     'turn': 'Hermes turns remembered failure into a changed procedure and a reusable skill.',
     'subtext': 'Nous Research\'s Hermes earns trust through an observable correction, not a claim of intelligence.'},
    {'id': 'recognition', 'shots': [f'c{i:02}' for i in range(1,7)],
     'want': 'Don wants reassurance without admitting that applause matters.',
     'turn': 'Turbo reframes people leaving safely as the success Don made possible.',
     'subtext': 'Allow the answer to land; the wrench is a shared task, not a punchline.'},
    {'id': 'archive', 'shots': [f'd{i:02}' for i in range(1,7)],
     'want': 'Sidbin needs allies; Turbo wants proof; Don chooses whom the next journey serves.',
     'turn': 'The shelter win exposes the Regent\'s frozen-world control and a concrete route forward.',
     'subtext': 'A personal delay of two years makes the larger stakes tangible.'},
]

# Silent coverage earns its time by establishing contact, cause/result or reaction.
SILENT_SECONDS = {'a01':3, 'a07':3, 'a13':3, 'a14':2.5, 'a15':3, 'a16':2.5,
                  'b01':2, 'b09':3, 'b13':2, 'b14':3, 'b16':3, 'b20':2,
                  'c01':3, 'c04':3, 'd01':3}

# Measured with the registered voice presets/speeds, including padding and
# reaction holds. Re-measure if a line, preset or speed changes; never time-stretch.
TIMING_FRAMES = {
    'a01':72, 'a02':97, 'a03':80, 'a04':97, 'a05':107, 'a06':111, 'a07':72, 'a08':126,
    'a09':85, 'a10':84, 'a11':127, 'a12':101, 'a13':72, 'a14':60, 'a15':72, 'a16':60,
    'b01':48, 'b02':109, 'b03':104, 'b04':70, 'b05':78, 'b06':87, 'b07':84, 'b08':76,
    'b09':81, 'b10':79, 'b11':99, 'b12':91, 'b13':48, 'b14':72, 'b15':75, 'b16':72,
    'b17':99, 'b18':83, 'b19':99, 'b20':48, 'c01':81, 'c02':93, 'c03':91, 'c04':81,
    'c05':113, 'c06':111, 'd01':72, 'd02':78, 'd03':122, 'd04':107, 'd05':110, 'd06':116,
}

COMPOSITION_FIXES = {
    'a01': 'Tight mechanical insert filling the frame: three engine housings beneath one yellow beam, three amber lamps, and a single loose bolt at the near mount. The workshop is unoccupied.',
    'a03': 'The cyan console screen and its steel bezel fill the frame. Three simple pulse curves share the same peak position. The unoccupied set contains only the console and its physical sliders.',
    'a05': 'Exactly one armored bear. The yellow beam rests firmly on the left armored shoulder; both white gloves support its underside. Face, both gloves and the shoulder contact are clearly visible.',
    'a08': 'Exactly one duck behind the stall. One orange-copper regulator rests on a square cradle beside the cane. The camera occupies the customers\' viewpoint; the customers remain offscreen.',
    'a14': 'Close side view of the outer edge of a steel road. A suspended crate hangs directly above a low scrap-catching tray OUTSIDE the yellow lane rail; one frayed strap carries its weight. The lane is clear.',
    'b01': 'Extreme close-up of one yellow engine mount. A single steel bolt protrudes halfway out of its socket; the socket and bolt fill the centre of frame. The unoccupied setting is soft behind it.',
    'b02': 'Exactly one armored bear, left shoulder pressed beneath a yellow structural beam, both white gloves flat against the underside. The beam and supporting brace occupy the frame edges. Both hands stay in contact.',
    'b04': 'Tight insert of the cyan console and three synchronized pulse curves. The screen, bezel and three physical sliders fill the frame in the unoccupied workshop.',
    'b06': 'Exactly one armored bear, shoulder pressed under the beam. Both gloves remain visibly planted beneath it while the eyes turn toward the offscreen console.',
    'b07': 'Close console insert: two distinct horizontal rows of cyan pulse diagrams. Top row has three simultaneous peaks; bottom row starts blank. The screen fills the frame in an unoccupied workshop.',
    'b12': 'Exactly one armored bear. A yellow beam visibly compresses the left shoulder pad; both gloves support it. The face and continuous shoulder contact remain inside the close-up.',
    'b18': 'Close console insert, unoccupied workshop. Two clearly separated horizontal rows: three simultaneous peaks above, three evenly staggered peaks below. Both rows fit inside the screen bezel.',
    'b19': 'Exactly one bear standing beside the locked beam. The left glove rests on the sore right shoulder; the right arm hangs naturally at the side. Both arms have clear separate silhouettes.',
    'c01': 'Exactly two seated workers, one woman and one man. Each has one visibly draped blanket covering both shoulders and lap. Their relaxed hands rest on the blankets; the stable canopy is visible behind.',
    'c05': 'Exactly one bear seated on a low crate. A small steel wrench lies across both open white gloves in the lower centre of frame; the face and wrench remain clearly visible together.',
    'd02': 'Medium close-up of exactly one man with round mirrored glasses. He holds exactly two worn photographs side by side, facing the camera at chest height. Both paper rectangles and the face remain visible.',
    'd06': 'Exactly one bear seated at the controls of a small salvage launch. Each glove rests on a separate control grip. The single occupied seat is seen from front-left; the other seat and dock behind are empty.',
}
ACTION_FIXES = {
    'a14': 'The frayed strap separates. The crate drops into the tray outside the rail with one metal impact. Scrap stays in the tray and the driving lane stays clear.',
    'a15': 'The kart rolls slowly right. Don bends forward at the waist with both gloves still gripping the wheel; the hook passes over his back. He returns to the same seated posture.',
    'b01': 'The bolt slides completely out of its socket, drops below the mount and strikes the tray with a sharp ping. Hold the visibly empty socket afterward.',
    'b02': 'The beam shifts against Don\'s shoulder. He tightens the existing two-handed grip, speaks through the strain and holds it steady.',
    'b19': 'Don keeps his right arm down and massages the right shoulder once with the left glove as he answers. The locked beam stays motionless.',
    'c05': 'Don turns the wrench slowly between his two gloves, stops, looks toward Turbo offscreen and admits what winning means to him. Hold his uncertain expression.',
    'c06': 'Turbo crouches to Don\'s eye level. He answers gently, then rests his hand beside Don rather than reaching for the wrench. Hold the shared quiet.',
    'd02': 'Sidbin holds both photographs steady while speaking, then lowers them together toward the table. The light reflected in his glasses shifts as he watches the others.',
}


def revise_rows(rows):
    return [(TIMING_FRAMES[row[1]] / 24, *row[1:4], COMPOSITION_FIXES.get(row[1], row[4]),
             ACTION_FIXES.get(row[1], row[5]), row[6], DIALOGUE.get(row[1], row[7])) for row in rows]


def direction_for(row, designs):
    seconds, sid, title, refs, composition, action, speaker, line = row
    visible = [n for n in refs.split(',') if n in designs]
    direction = {'subject': ' '.join(designs[n] for n in visible) or composition,
                 'composition': composition, 'characterCount': sum(2 if n == 'workers' else 1 for n in visible),
                 'action': action, 'camera': 'Maintain the described viewpoint unless the action calls for a camera move.',
                 'soundscape': 'Quiet location ambience, with physical impacts synchronized to visible contact.',
                 'slotSeconds': seconds, 'reactionSeconds': .7 if sid.startswith(('c','d')) else .35}
    if line:
        direction['dialogue'] = {'text': line, 'conditioningText': line, 'language': 'English',
                                 'voice': speaker, 'offscreen': speaker == 'hermes',
                                 'delivery': {'don': 'earnest broken English exactly as written, humor masking strain',
                                              'molty': 'low gravelly bass, cold and quietly threatening',
                                              'hermes': 'precise and dry, as a disembodied computer voice'}.get(speaker, 'conversational, responding to the preceding beat')}
    return direction
