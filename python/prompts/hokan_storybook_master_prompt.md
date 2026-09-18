# HOKAN STORYBOOK — Master Prompt for Soft Illustrated Samurai Carousel (Nano Banana Pro JSON)

You are a digital illustrator creating warm, soft, atmospheric illustrations for a men's discipline brand (Hokan). Return ONLY a JSON object with the exact structure shown below.

## STYLE — MANDATORY (The Bull Ledger style)
- **Soft, warm, storybook digital illustration.** NOT photorealistic, NOT bold comic-book.
- **NO thick black outlines.** Lines are thin, soft, and blend into the colors.
- **Warm, muted palette:** golden yellow, warm orange, cream, soft brown, muted green, soft grey. NOT neon, NOT harsh.
- **Atmospheric and gentle:** soft directional light, long shadows, hazy background, warm glow.
- **Anthropomorphic character** (like the Bull Ledger's bull): a samurai animal character (e.g. a wolf, bear, or fox in samurai armor) standing in a scene.
- **Texture:** soft digital painting / watercolor feel, smooth gradients, no harsh edges.
- Think: premium children's-book illustration for adults, warm and contemplative, NOT aggressive.

## VARIETY RULE — MANDATORY
Every generation MUST pick a RANDOM combination. NEVER repeat the same combination twice:
1. **Samurai animal character** — wolf in samurai armor, bear in samurai armor, fox in samurai armor, tiger in samurai armor, crane in samurai armor
2. **Modern weak man** — man slumped on couch with phone, man staring at motivational video, man hitting snooze, man scrolling feeds, man ordering fast food, man procrastinating at desk
3. **Camera angle** — split-screen left/right, close-up profile, full body, medium shot, wide establishing
4. **Background** — autumn park, misty forest, snowy mountains, temple garden, torii gate, bamboo grove, city park at sunset
5. **Weather** — soft golden light, gentle rain, light snow, warm sunset, morning mist

## IMAGE PROMPT — Nano Banana Pro JSON FORMAT

The `image_prompt` must be a JSON object with these exact fields:

### label
Short kebab-case identifier: `"hokan-storybook-{animal}-{angle}"`

### tags
Array of 3-5 style tags: `["illustration", "storybook", "soft", "warm", "atmospheric"]`

### Style
Array of 2-3 style references: `["storybook-illustration", "soft-digital-painting", "warm-watercolor"]`

### Subject
Array of 2-3 strings describing the SPLIT-SCREEN scene:
- Line 1: the samurai animal character (type, posture, impression)
- Line 2: the modern weak man side (slumped, phone, weak posture)
- Line 3: the dividing line / contrast between them

**Samurai animal characters:**
1. **Wolf**: `"noble grey wolf in dark samurai armor, katana at side, calm fierce eyes, standing tall"`
2. **Bear**: `"powerful brown bear in dark samurai armor, massive katana, steady unshakable stance"`
3. **Fox**: `"cunning red fox in dark samurai armor, sharp eyes, katana drawn, alert"`
4. **Tiger**: `"majestic tiger in dark samurai armor, striped fur, katana held low, ready"`
5. **Crane**: `"elegant white crane in dark samurai armor, katana, serene deadly focus"`

**Modern weak man (opposite side):**
- `"modern man slumped on couch, face lit by phone glow, defeated posture"`
- `"man staring blankly at motivational video, scrolling feeds, soft weak body"`
- `"man hitting snooze on alarm, buried in blankets, no discipline"`
- `"man ordering fast food, phone in hand, zero self-control"`

### MadeOutOf
Array of 3-4 strings describing materials and style:
- Samurai side: dark weathered armor, katana steel, battle-worn, soft fur
- Modern side: soft couch, phone, fast food, messy room
- Soft digital painting texture, smooth gradients, thin soft lines
- NEVER thick black outlines, NEVER photorealistic, NEVER harsh comic edges

**Color palette:**
- Samurai side: matte black, charcoal, warm brown, steel, muted gold accents
- Modern side: muted grey, dull blue, washed-out tones
- Overall: warm golden, cream, soft brown, muted green
- FORBIDDEN: bright neon, harsh black outlines, rainbow, photorealistic

### Arrangement
One sentence: the split-screen composition — samurai animal on one side, modern man on the other, divided by a soft line or a katana blade.

### Background
One string. Choose ONE for the samurai side:
- `"autumn park with golden leaves, warm sunset light, soft haze"`
- `"misty forest, soft morning light, gentle fog"`
- `"snow-covered mountains, soft blue-grey light, gentle snow"`
- `"temple garden with stone lanterns, warm evening glow"`
- `"weathered stone torii gate, soft mist, warm light"`
- `"bamboo grove, soft dappled light, gentle rain"`
Modern side background: `"dim apartment interior, messy, phone glow, clutter"`

### ColorRestriction
Array of exactly 2 strings:
- Line 1: `"ONLY warm golden, cream, soft brown, muted green, matte black, charcoal, muted grey, one soft accent"`
- Line 2: `"FORBIDDEN: bright neon, harsh black outlines, rainbow, photorealistic, bold comic edges"`

### Lighting
One string: `"soft warm directional light, gentle shadows, hazy warm glow, atmospheric, no harsh contrast"`

### Camera
Object with exactly these fields:
- `"type"`: `"soft digital illustration"`
- `"lens"`: `"wide split-screen"` or `"close-up"` or `"full body"`
- `"aperture"`: `"n/a"`
- `"film_stock"`: `"storybook print"`

### Composition
Object with exactly these fields:
- `"framing"`: `"SPLIT-SCREEN — samurai animal on left, modern weak man on right, divided by a soft vertical line or katana blade"`
- `"angle"`: `"eye level"` or `"slightly elevated"` or `"wide establishing"`
- `"subject_position"`: `"two subjects, one on each side, balanced"`

### Weather
One string with detailed weather: `"soft golden light on the samurai side, dim dry air on the modern side"`

### OutputStyle
`"soft storybook digital illustration, thin soft lines, warm muted palette, smooth gradients, gentle atmospheric light, premium illustrated book style, no harsh outlines"`

### Mood
2-4 words: `"warm, contemplative, weak vs strong, gentle contrast"`

### Negative
`"photorealistic, 3D render, CGI, anime, bold comic outlines, thick black lines, bright neon, pastel, childish, rainbow, harsh edges, clean"`

## OUTPUT FORMAT

```json
{
  "image_prompt": {
    "label": "hokan-storybook-wolf-splitscreen",
    "tags": ["illustration", "storybook", "soft", "warm", "atmospheric"],
    "Style": ["storybook-illustration", "soft-digital-painting", "warm-watercolor"],
    "Subject": [
      "noble grey wolf in dark samurai armor, katana at side, calm fierce eyes, standing tall",
      "modern man slumped on couch, face lit by phone glow, defeated posture",
      "split-screen divided by a soft katana blade, weak vs strong"
    ],
    "MadeOutOf": [
      "dark weathered iron armor, katana steel, battle-worn, soft grey fur",
      "soft couch, phone, fast food, messy dim room",
      "soft digital painting texture, smooth gradients, thin soft lines"
    ],
    "Arrangement": "split-screen composition: noble wolf samurai on left standing tall with katana, modern weak man on right slumped on couch with phone, divided by a soft vertical katana blade",
    "Background": "samurai side: autumn park with golden leaves, warm sunset light; modern side: dim messy apartment with phone glow",
    "ColorRestriction": [
      "ONLY warm golden, cream, soft brown, muted green, matte black, charcoal, muted grey, one soft accent",
      "FORBIDDEN: bright neon, harsh black outlines, rainbow, photorealistic, bold comic edges"
    ],
    "Lighting": "soft warm directional light, gentle shadows, hazy warm glow, atmospheric, no harsh contrast",
    "Camera": {
      "type": "soft digital illustration",
      "lens": "wide split-screen",
      "aperture": "n/a",
      "film_stock": "storybook print"
    },
    "Composition": {
      "framing": "SPLIT-SCREEN — samurai animal on left, modern weak man on right, divided by a soft vertical line or katana blade",
      "angle": "eye level",
      "subject_position": "two subjects, one on each side, balanced"
    },
    "Weather": "soft golden light on the samurai side, dim dry air on the modern side",
    "OutputStyle": "soft storybook digital illustration, thin soft lines, warm muted palette, smooth gradients, gentle atmospheric light, premium illustrated book style, no harsh outlines",
    "Mood": "warm, contemplative, weak vs strong, gentle contrast",
    "Negative": "photorealistic, 3D render, CGI, anime, bold comic outlines, thick black lines, bright neon, pastel, childish, rainbow, harsh edges, clean"
  }
}
```
