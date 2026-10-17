"""Willem's 3rd-birthday video: FLUX 3 Klein reference-edit stills + LTX-2.5 i2v prompts.
The reference image is the cropped family photo (kept outside the repo)."""
CHAR = ("the little girl from the reference image reimagined as an adorable Pixar-style 3D animated character: "
        "a three-year-old girl with light brown tousled hair, big expressive brown eyes, rosy cheeks and a huge joyful smile, "
        "wearing her coral-red ribbed headband with a big bow on top of her head")
OUTFIT = ", a red top and a cream knit cardigan"
STYLE = (" Soft 3D animated feature-film render, warm cinematic lighting, vibrant colours, wholesome and joyful, "
         "wide 16:9 shot, the girl's face clearly visible and recognisable. No text, no letters, no numbers, no logos.")
# (id, still prompt body, LTX i2v motion, French lower-third line, French narration)
SCENES = [
 ("portrait", f"Character portrait of {CHAR}{OUTFIT}, upper body, waving hello at the viewer, soft warm pastel peach background with gentle bokeh.",
  "She waves hello at the viewer, blinks and smiles warmly, her hair and bow bounce gently.",
  None, None),
 ("rocket", f"{CHAR}{OUTFIT}, piloting a small shiny red-and-white rocket ship through outer space, seen through the big round cockpit window, hands on the controls, the glowing Moon ahead and Earth behind, colourful stars.",
  "The rocket flies toward the Moon, the girl grips the controls and laughs, stars streak past, the control lights blink.",
  "Pilote de fusée !", "Willem, pilote de fusée, file tout droit vers la Lune !"),
 ("surf", f"{CHAR}, wearing a red rash-guard top, surfing a huge curling turquoise wave on a small yellow surfboard, arms out for balance, sparkling spray, bright sunny sky.",
  "She rides along the curling wave on her surfboard, spray sparkles around her, her hair blows in the wind.",
  "Reine du surf !", "Une vague géante ? Aucun problème pour la reine du surf !"),
 ("racecar", f"{CHAR}{OUTFIT}, driving a small shiny red race car on a race track, both hands on the steering wheel, big grin, motion-blurred colourful grandstands behind her.",
  "The little race car speeds along the track, the background streaks past, she grips the wheel and grins.",
  "Pilote de course !", "Vroum ! Elle prend le virage à toute vitesse !"),
 ("dj", f"{CHAR}{OUTFIT}, a big pair of headphones around her neck, playing music at a kid-sized DJ booth at a colourful dance party, cute cartoon animal friends dancing, disco lights and balloons.",
  "She bobs her head and taps the DJ buttons, the disco lights sweep and the animal friends dance.",
  "DJ de la soirée !", "Place à la DJ ! Tout le monde danse avec Willem !"),
 ("dragon", f"{CHAR}{OUTFIT}, riding on the back of a friendly round-faced green dragon flying above fluffy clouds and a fairy-tale castle at golden sunset.",
  "The friendly dragon flaps its wings and glides over the clouds, the girl holds on and cheers.",
  "Dresseuse de dragon !", "Et maintenant, une balade à dos de dragon au-dessus des nuages !"),
 ("soccer", f"{CHAR}, wearing a red soccer jersey, kicking a soccer ball into the goal net in a bright stadium, the ball flying into the net, confetti in the air.",
  "She kicks the ball and it flies into the net, confetti falls and she throws her arms up in celebration.",
  "But gagnant !", "Elle tire… et c'est le but gagnant !"),
 ("orchestra", f"{CHAR}{OUTFIT}, standing on a small podium conducting an orchestra of cute animals with a little baton: a bear playing cello, a rabbit playing violin, an elephant playing trumpet, warm stage lights.",
  "She waves the little baton in time, the animal musicians play and sway, the stage lights glow.",
  "Cheffe d'orchestre !", "Maestro Willem dirige l'orchestre des animaux !"),
 ("cake", f"{CHAR}{OUTFIT}, leaning in to blow out exactly three lit candles on a giant colourful three-tier birthday cake, balloons and confetti, cozy party room, warm golden light.",
  "She takes a breath and blows, the three candle flames flicker and go out, confetti drifts down, balloons sway.",
  "Joyeux 3e anniversaire, Willem !", "Trois bougies, un grand souffle… Joyeux anniversaire, Willem ! On t'aime fort !"),
]
# Second pass after review (VM still warm): soccer s11/s12 showed no kick; cake s11 smiled instead of blowing.
REDO = [
 ("soccer2", f"{CHAR}, wearing a red soccer jersey and little shorts, full body, mid-kick in a bright stadium, her foot just striking a soccer ball that flies toward the goal net, confetti in the air, a cheering crowd blurred behind."),
 ("cake2", f"{CHAR}{OUTFIT}, cheeks puffed, blowing out exactly three lit candles on a giant colourful three-tier birthday cake in front of her, balloons and confetti, cozy party room, warm golden light."),
]
# i2v second pass: soccer ball rolled oddly and billboards grew pseudo-text; surf barely moved.
I2V_REDO = {
 "soccer2": "The soccer ball flies away from her foot into the goal net and the net ripples, she hops with joy and raises both arms, confetti keeps falling, the crowd is a soft blur.",
 "surf": "She surfs fast along the face of the curling wave, the yellow board carves through the water, spray flies up behind her, her hair streams in the wind, the camera tracks smoothly alongside her.",
}
