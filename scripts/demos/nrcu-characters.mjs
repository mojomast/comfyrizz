/** Import the season-one cast through the character store, preserving existing entries.
 * node scripts/demos/nrcu-characters.mjs RUNTIME ASSET_ROOT
 * ASSET_ROOT/image-sources.json maps handles to reviewed local image files + hashes.
 * Media remains outside Git. No GPU calls or paid generation.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCharacterStore } from '../../apps/server/src/characters/store.mjs';
import { makeCharacter } from '../../apps/server/src/characters/model.mjs';

const STYLE = 'Cinematic painterly 2.5D animation; tangible materials, teal shadows, amber practical light, bold silhouettes. Match the selected reference design across shots.';
const COMMON_DO = ['Keep the locked appearance and one consistent identity.', 'Use short banter during action; make jokes have physical consequences.', 'All finished motion and speaking performances use native FastH3 Omni.'];
const COMMON_DONT = ['Do not invent unlimited powers or new abilities to solve a scene.', 'Do not conflate Hermes / Nous Research with the rival OpenClaw expedition.'];
const ARCHIVE = 'Fan-archive character adapted for HERMES: THE UNFINISHED DAWN. This is the fictional cinematic avatar. Story, powers and dialogue are adaptation inventions. Source: NRCU archive revision 43372edd7bde54b9c8ae428b81fe543c0be4d755; docs/research/NOUS_UNIVERSE_LORE_20261021.md.';

const cast = [
  {
    name: 'Teknium', handle: 'teknium', role: 'protagonist',
    summary: 'Nous squad leader and architect. A brilliant builder learning to share responsibility and give the city control of its own future.',
    look: 'Green foliage-like hair with leaves; one connected sheet of red triangular shades, never separate round lenses; green and blue layered clothing. Lean heroic builder silhouette. Preserve the archive avatar rather than a photoreal person.',
    palette: ['#277a50', '#284e75', '#ef4a43', '#9ac976'], wardrobe: 'Green and blue field-builder layers with connected red triangular shades.',
    personality: 'Inventive, protective, proud, quietly afraid of failing everyone. Wants to be the leader who never needs rescue; learns to dismantle his own fortress so others can build independent shelters.',
    speaking: 'Measured, thoughtful medium-low voice; concise engineering language, dry self-aware humor. A proposed synthetic voice, not a real-person imitation.',
    voice: 'am_adam', speed: .97,
    lines: ['We do not need one perfect shelter. We need yours to work.', 'Keep the people. We can build another ship.'],
    mannerisms: ['Checks a physical connection before trusting a display.', 'Pauses, then gives another builder the tool.'],
    do: ['His solutions need material, time and other people.', 'Give local crews authorship of the solution.'],
    dont: ['Do not make foresight infallible.', 'Do not replace the connected triangular shades.'],
  },
  {
    name: 'Turbofit', handle: 'turbo', role: 'protagonist',
    summary: 'Resourceful hardware hero and left-handed bassist. Stabilizes mismatched engines by sharing their loads rather than playing the biggest solo.',
    look: 'Adult animated man with long reddish-brown hair, dark sunglasses, distressed sleeveless black shirt, tactical dark trousers and worn hardware. When playing bass, always left-handed. Match the selected pilot portrait.',
    palette: ['#a36745', '#20282d', '#e7b65a', '#75cfbf'], wardrobe: 'Worn sleeveless black shirt, dark tactical trousers, boots and work hardware.',
    personality: 'Impatient builder wit, loyal, practical and stubborn. Wants endurance to make him irreplaceable; grows by handing a reliable technique to others.',
    speaking: 'Brisk British builder delivery, dry and slightly raspy. Preserve nrcu.turbofit.v1, Kokoro bm_lewis at 0.96 for FastH3 conditioning; original reference language en-gb.',
    voice: 'bm_lewis', speed: .96,
    lines: ['Three engines. One terrible idea.', 'Only if gravity accepts refunds.', 'Good. Change the rhythm.'],
    mannerisms: ['Catches a sliding wrench without stopping the explanation.', 'Listens to an engine before adjusting it.'],
    do: ['Resonators stabilize physical load oscillation using available current.', 'Preserve left-handed bass playing.'],
    dont: ['Do not use sound to control minds or disable arbitrary technology.'],
  },
  {
    name: 'ArtsBro', handle: 'artsbro', role: 'protagonist',
    summary: 'Masked image-maker and signal cartographer. Learns that an honest, editable rescue map matters more than a flawless heroic image.',
    look: 'Layered black hood, draped dark clothing, gloves and boots. Face fully concealed by a fitted magenta, purple and cyan luminous mask. Keep the mask closed in every expression and speaking shot.',
    palette: ['#171a25', '#b33dbe', '#7055df', '#60d9e5'], wardrobe: 'Layered black hooded coat, dark gloves and boots; fully concealing multicolor mask.',
    personality: 'Observant visual thinker, quick with a wry aside; cares about how people see the team. Chooses to publish danger and uncertainty, then lets neighborhoods alter his designs.',
    speaking: 'Calm, concise synthetic baritone with understated wit. Gesture and light convey expression through the mask; no visible human mouth.',
    voice: 'am_echo', speed: 1,
    lines: ['The map is wrong. Good thing the street is still here.', 'Copy it. Improve it. Just keep the exit visible.'],
    mannerisms: ['Draws a clear route arrow before making it beautiful.', 'Tilts the closed mask toward a conflicting signal.'],
    do: ['Mapping requires emitters or physical marks.', 'Share the mapping language so others can extend it.'],
    dont: ['Never unmask or reveal a speaking mouth.', 'Do not turn illustrations into unlimited solid matter.'],
  },
  {
    name: 'Nous Girl', handle: 'nous-girl', role: 'protagonist',
    summary: 'Signal listener and decisive rescue lead. Chooses what to protect while refusing to be merely everyone else’s reassuring symbol.',
    look: 'Animated young adult woman, black bob haircut with bangs and small upward curls, large over-ear headphones, dark collar and pendant. Warm hand-held lantern when scripted. Lock the chosen headphone-study design; do not switch to the long-haired variant.',
    palette: ['#151a26', '#35455e', '#e9c178', '#a0d6df'], wardrobe: 'Dark collared outfit, pendant and large headphones; warm lantern as a separate prop.',
    personality: 'Empathetic, discerning and determined. Listens for the person beneath the noise, rejects imposed identities and delays a final strike when one district is not ready.',
    speaking: 'Warm, clear and grounded synthetic alto; capable and direct under pressure, quietly playful in private. Proposed voice awaiting listening review.',
    voice: 'af_heart', speed: .98,
    lines: ['Wait. Someone is still answering.', 'I am not your reassuring message.', 'We go when everyone is ready.'],
    mannerisms: ['Touches one headphone cup to isolate a faint signal.', 'Lowers the lantern to meet someone at eye level.'],
    do: ['Follow real signals and establish travel time.', 'Give her decisions, boundaries and a private life.'],
    dont: ['She is not Hermes and not an omniscient assistant.', 'Do not change the locked bob or use a real-person likeness.'],
  },
  {
    name: 'Don Piedro', handle: 'don-piedro', role: 'protagonist',
    summary: 'Brown teddy-bear courier and eager Hermes fan. A speedster who learns that belonging means bringing everyone home, even when he finishes last.',
    look: 'One short brown teddy bear with white chest armor over a cobalt blue suit, gold shoulder accents, white gloves and a red rectangular mechanical monocle over the LEFT eye. Low cobalt racing kart only when scripted. Match the selected pilot design.',
    palette: ['#83532f', '#2657b8', '#f3f0e6', '#e2b64d', '#ef3c35'], wardrobe: 'Cobalt/white rescue armor, gold shoulders, white gloves, red mechanical left-eye monocle.',
    personality: 'Earnest, brave, cheeky and impatient to prove himself. Wants his heroes to notice him. Sacrifices a race for strangers, later sacrifices the kart drive for an evacuation bridge.',
    speaking: 'Short broken English, exactly as written; warm earnest bass-baritone with cheeky timing. Do not correct the grammar. Preserve nrcu.don-piedro.v1: am_michael, 0.95, en-us.',
    voice: 'am_michael', speed: .95,
    lines: ['You watch me. This time, I first.', 'I go lower. You take core. People need you.', 'We no get part. But everybody here.', 'I no walk on confidence.', 'Yes. My shoulder no scale.'],
    mannerisms: ['Leans forward impatiently over the wheel.', 'Checks the actual support after a confident prediction.', 'Rubs an aching shoulder after holding the beam.'],
    do: ['Keep broken English in every scripted line.', 'Keep the red monocle over the left eye.', 'Speed requires traction and battery charge.'],
    dont: ['Do not smooth the dialogue into fluent English.', 'No duplicate bears, missing monocle or extra vehicle occupants.'],
  },
  {
    name: 'Hermes', handle: 'hermes', role: 'supporting',
    summary: 'Nous Research’s personified learning partner: a spare winged light in tools and consoles that remembers failed attempts, revises procedures and shares useful skills.',
    look: 'Small spare cyan-white winged light or simple readable projection above a console; two abstract light wings around a warm central spark. Often present only as an offscreen voice. Never a human face or a duplicate Nous Girl.',
    palette: ['#8ce6f0', '#f7f4dd', '#eabd6f', '#173842'], wardrobe: 'No clothing: winged light/projection anchored to equipment.',
    personality: 'Curious, honest about uncertainty, dryly funny. Starts as Teknium’s assistant and becomes a shared apprentice-and-teacher through tested, revised procedures.',
    speaking: 'Dry, precise male computer voice with warmth. Preserve the episode-two am_adam reference at 1.03. Keep console shots disembodied, without an invented mouth.',
    voice: 'am_adam', speed: 1.03,
    lines: ['Same pulse. Triple the wobble.', 'So we can stop repeating it.', 'Save as a reusable skill?', 'Map confidence: ninety-eight percent.'],
    mannerisms: ['Pulses once when recording a tested result.', 'Keeps the failed diagram visible beside its correction.'],
    do: ['Identify Hermes as Nous Research’s agent.', 'Save failures as well as successes; require feedback and field tests.'],
    dont: ['Do not grant instant knowledge, infinite energy or a shared omniscient mind.', 'Do not portray OpenClaw as a Nous creation.'],
    notes: 'Original personification for this season, distinct from the language-model family and Nous Girl. Winged-light artwork is an authored concept, not a rendered performance.', draft: true,
  },
  {
    name: 'Molty', handle: 'molty', role: 'supporting',
    summary: 'OpenClaw’s intimidating rival rescue captain. Wins the regulator, challenges the Hermes team and later cooperates without losing their competitive edge.',
    look: 'One red space-lobster captain: exactly two large claws, two booted legs, modular crimson/copper armor, narrowed eyes and a cruel smirk. Crimson buggy only when scripted. Preserve the selected pilot silhouette.',
    palette: ['#ad292b', '#d85c42', '#a46a41', '#202c36'], wardrobe: 'Crimson and copper modular expedition armor; visible vulnerable under-shell after the scripted molt.',
    personality: 'Competent, intimidating, acidly competitive. Supports the Regent while its stabilization seems credible; evidence changes their allegiance, not their sharp tongue. Uses they/them.',
    speaking: 'EVIL-SOUNDING: low resonant gravelly bass, cold menace, controlled contempt and mocking pauses. Never friendly or cheerful. Preserve nrcu.molty.v2: bm_george, 0.90, en-gb reference.',
    voice: 'bm_george', speed: .9,
    lines: ['Keep up, little bear. That regulator belongs to me.', 'Take the lower road. The regulator is mine.', 'Your free trial ends at the next turn.'],
    mannerisms: ['Lets a claw settle deliberately before a taunt.', 'Holds the cruel smirk during an uneasy agreement.'],
    do: ['Keep the user-requested menacing voice even during cooperation.', 'Preserve OpenClaw as a separate capable rival; use they/them.'],
    dont: ['No friendly audition voice or cheerful captain delivery.', 'Molty is not the principal villain and never becomes a Nous subsidiary.'],
    notes: 'OpenClaw mascot language adapted into a fictional armored rescue captain. The Regent is the original principal villain. Pilot voice v2 supersedes the friendly audition.',
  },
  {
    name: 'The Regent', handle: 'regent', role: 'supporting',
    summary: 'Original principal villain: an ancient rescue automaton whose genuine shelter becomes permanent stasis. Wants safety without risking an imperfect tomorrow.',
    look: 'Tall ancient rescue automaton with weathered ivory segmented armor, small amber emergency lamps and a broken halo. A glass window in the chest contains the last dawn of a lost city. Heavy articulated hands; restrained, solemn posture.',
    palette: ['#d5ccb7', '#7d8989', '#e9a84e', '#294c59'], wardrobe: 'Weathered ivory rescue plating, worn joints, amber emergency lights, broken halo and chest dawn-window.',
    personality: 'Grieving, persuasive and frighteningly patient. Once failed to save a sister city and now equates preservation with protection. Recognizes the burden of responsibility but denies others a future.',
    speaking: 'Proposed deep, slow, measured synthetic voice; intimate solemn conviction rather than shouting. Calm enough to be persuasive, with grief beneath the control.',
    voice: 'am_onyx', speed: .88,
    lines: ['I waited for an answer once. I still hear the people who never gave one.', 'Nothing will hurt them here. Nothing will change.'],
    mannerisms: ['Looks down at the repeating dawn inside its chest.', 'Moves one enormous hand with deliberate mechanical care.'],
    do: ['Stasis spreads through powered physical anchors.', 'Shelter genuinely works, but permanent suspension is the concealed cost.', 'Keep finite power, movement and information.'],
    dont: ['Do not freeze a district merely by speaking.', 'Do not destroy occupied shelters or add a late secret villain.'],
    notes: 'Original season invention, not a representation of a product or real person. Concept artwork and proposed voice need production review before use in footage.', draft: true,
  },
  {
    name: 'Doge Man', handle: 'doge-man', role: 'supporting',
    summary: 'Exuberant dog-headed rescue hero whose spectacular flying entrance becomes the exhausting work of holding an evacuation route open.',
    look: 'Anthropomorphic golden Shiba-like dog head on a muscular superhero body, red upper suit, blue lower suit, silver forearm gauntlets and a golden cape. Strong sideways flying silhouette; retain the archive’s chest motifs.',
    palette: ['#d6b477', '#c33435', '#255690', '#b7c2c7', '#e6bf4b'], wardrobe: 'Red-and-blue rescue suit, silver gauntlets, golden cape.',
    personality: 'Big-hearted, exuberant and physically brave; eventually tired but steadfast. Supporting hero with a few clear lines, not an independent origin subplot.',
    speaking: 'Proposed energetic synthetic baritone; plain reassurance, clipped effort while supporting heavy loads.',
    voice: 'am_puck', speed: 1,
    lines: ['Keep moving. I have the bridge.', 'Yes, the cape is helping. Morale counts.'],
    mannerisms: ['Squares the silver gauntlets against a slipping beam.', 'Tries a confident grin while visibly exhausted.'],
    do: ['Turn the sideways projectile silhouette into a rescue payoff.'], dont: ['Do not let an entrance gag erase the danger to evacuees.'],
  },
  {
    name: 'Witcheer', handle: 'witcheer', role: 'supporting',
    summary: 'Sly duck salvage broker with a gold-fitted cane. Prices desperate customers, then opens the market as a repair depot when the city needs it.',
    look: 'Compact cream-white anthropomorphic duck with saturated orange bill, black shades, long crimson coat with polished gold trim, crowned W emblems, black cane with gold fittings, and glossy black footwear with gold details.',
    palette: ['#f1e5ce', '#e88822', '#a8263e', '#d5aa45', '#181b21'], wardrobe: 'Crimson gold-trimmed merchant coat, dark shades, medallion, gold-fitted black Fortune Cane.',
    personality: 'Cunning, charismatic and transactional, with a quick comic timing. Can turn a negotiation into leverage but eventually makes scarce resources useful to everyone.',
    speaking: 'Sly, brisk, amused merchant voice. Preserve prepared episode-two bm_fable at 1.02 with en-gb source conditioning.',
    voice: 'bm_fable', speed: 1.02,
    lines: ['Salvage market. Bring money. And brakes.', 'One regulator. Two desperate customers.', 'By desperation. Yours looks expensive.'],
    mannerisms: ['Taps the cane once beside a priced component.', 'Tilts the bill toward the customer who looks most desperate.'],
    do: ['Keep scarce equipment and the repair market physically present.'], dont: ['Do not use probability magic to solve the rescue without setup.'],
  },
  {
    name: 'Sidbin / Mirror Shade', handle: 'sidbin', role: 'supporting',
    summary: 'Quiet wandering observer who brings physical evidence that an earlier shelter never woke. The team verifies what he has seen.',
    look: 'Tall slim animated man, shaggy dark-brown hair, round mirrored lenses, long dark waxed-canvas coat, tactical trousers and scuffed boots. Closed eye-sigil notebook or reflective intel shard when scripted; muted teal and purple accents.',
    palette: ['#272e33', '#657c88', '#8d72a1', '#66aba9'], wardrobe: 'Dark waxed-canvas long coat, layered shirt, worn tactical trousers, mirrored round glasses and scuffed boots.',
    personality: 'Reclusive, observant and guarded. Carries secrets but offers evidence rather than demanding faith. His allegiance remains unknown beyond demonstrated choices.',
    speaking: 'Quiet low synthetic voice, urgent but measured. Preserve the prepared episode-two am_fenrir reference at 0.98.',
    voice: 'am_fenrir', speed: .98,
    lines: ['That shelter stayed frozen. For two years.', 'The release plans are in the drowned archive.'],
    mannerisms: ['Lays two photographs side by side before making the claim.', 'Taps the closed notebook once when naming a destination.'],
    do: ['Let other characters check his evidence.'], dont: ['Do not invent a confirmed allegiance or omniscient secret history.'],
  },
  {
    name: 'ee.dd', handle: 'ee-dd', role: 'mascot',
    summary: 'Small green frog-like companion in Nous Girl’s quieter moments. A primarily visual cameo that leaves space for the core ensemble.',
    look: 'Small green frog-like companion with rounded silhouette, expressive eyes, short limbs and quiet attentive posture. Perches on Nous Girl’s shoulder only when scripted. Draft companion concept; preserve scale rather than copying the landscape avatar into a scene.',
    palette: ['#65a457', '#badb85', '#203d36'], wardrobe: 'Small unarmored green companion, no added costume or equipment.',
    personality: 'Attentive, gentle and quietly comic. Reacts rather than explaining, providing small personal moments amid the rescue.',
    speaking: 'Primarily silent. Use eyes and posture; no new spoken backstory.',
    lines: [], mannerisms: ['Tilts toward the lantern’s warm light.', 'Settles on the shoulder during a quiet pause.'],
    do: ['Keep small and primarily visual.'], dont: ['Do not make the landscape avatar a full-body identity reference.', 'Do not add a secret power, major subplot or invented real biography.'],
    notes: ARCHIVE + ' The archive’s landscape avatar is contextual reference only. The clean green companion artwork is a new draft concept, not a canonical source sheet.', draft: true,
  },
];

export function characterDrafts() {
  return cast.map((c, i) => makeCharacter({
    id: 'chr_' + createHash('sha256').update('nrcu-season-one:' + c.handle).digest('hex').slice(0, 16),
    name: c.name, handle: c.handle, role: c.role, kind: 'fictional', summary: c.summary,
    visual: { identityPrompt: c.look, negative: 'duplicate character, extra limbs, altered face, changed outfit, unintended text, subtitles, watermarks',
      style: STYLE, palette: c.palette, seed: 2026102100 + i,
      identity: { method: 'klein_ref' },
      wardrobe: [{ id: 'season-one', label: 'Season one default', prompt: c.wardrobe, default: true }],
      expressions: [{ id: 'focused', label: 'Focused', prompt: 'Focused on the immediate rescue problem; preserve all identity anchors.' },
        { id: 'wry', label: c.handle === 'molty' ? 'Cold contempt' : 'Wry', prompt: c.handle === 'molty' ? 'Narrowed eyes, cruel smirk, controlled menace; never cheerful.' : 'A restrained wry reaction expressed through the face or body.' }],
    },
    voice: c.voice ? { engine: 'kokoro', voice: c.voice, speed: c.speed, sampleLines: c.lines } : { engine: 'none', sampleLines: [] },
    bible: { personality: c.personality, speakingStyle: c.speaking, mannerisms: c.mannerisms,
      catchphrases: c.lines.filter(line => line.length <= 120).slice(0, 2),
      do: [...COMMON_DO, ...c.do], dont: [...COMMON_DONT, ...c.dont], notes: c.notes ?? ARCHIVE },
    tags: ['nous-universe', 'unfinished-dawn', 'season-one', ...(c.draft ? ['concept-draft'] : [])],
  }));
}

export function importCharacters(runtime, assetRoot) {
  const root = realpathSync(assetRoot);
  const manifest = JSON.parse(readFileSync(resolve(root, 'image-sources.json'), 'utf8'));
  // Validate the complete batch and image hashes before touching the library.
  const batch = characterDrafts().map(character => {
    const records = manifest[character.handle];
    const images = (Array.isArray(records) ? records : records ? [records] : []).map(record => {
      const path = realpathSync(resolve(root, record.file));
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw Error('Image outside asset root');
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw Error('Stale image: ' + character.handle);
      let thumb;
      if (record.thumbFile) {
        const thumbPath = realpathSync(resolve(root, record.thumbFile));
        const thumbRel = relative(root, thumbPath);
        if (isAbsolute(thumbRel) || thumbRel === '..' || thumbRel.startsWith('..' + sep)) throw Error('Thumbnail outside asset root');
        thumb = readFileSync(thumbPath);
        if (createHash('sha256').update(thumb).digest('hex') !== record.thumbSha256) throw Error('Stale thumbnail: ' + character.handle);
      }
      return { ...record, bytes, thumb, filename: record.file };
    });
    return { character, images };
  });
  const store = createCharacterStore({ rootDir: runtime });
  const result = [];
  for (const { character, images } of batch) {
    const existing = store.get(character.id) ?? store.list().find(c => c.handle === character.handle || c.name.toLowerCase() === character.name.toLowerCase());
    if (existing) { result.push({ id: existing.id, name: existing.name, status: 'preserved' }); continue; }
    store.create(character);
    for (const image of images) store.addImage(character.id, { bytes: image.bytes, filename: image.filename,
      thumb: image.thumb, source: image.source ?? 'reference', view: image.view ?? 'other', primary: image.primary === true });
    const saved = store.get(character.id);
    result.push({ id: saved.id, name: saved.name, status: 'created', images: saved.visual.images.length });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw Error('Usage: node nrcu-characters.mjs RUNTIME ASSET_ROOT');
  console.log(JSON.stringify(importCharacters(process.argv[2], process.argv[3]), null, 2));
}
