# SlopShield

Consuming anything online is a constant struggle to filter quality from clickbait - a quiet battle between you and the creators and algorithms trying to make few extra cents per click, your attention is all they need.

Degenerative AI has aggressively tipped that battle: mass-producing low-quality slop that's indistinguishable from real content is now nearly effortless.

**This is an attempt to fight back.**

Instead of using AI to generate yet more content nobody asked for, it points the model the other way - letting it chew through the endless feed of garbage so you don't have to. Every video on your YouTube homepage gets a 0-100 bullshit score and a one-sentence summary of what's actually inside, judged from the transcript.

A content-level firewall for the asymmetric battle against unsolicited slop.

<p>
<img src="screenshots/bait-gates-ai.png" width="49%" alt="78 BAIT: vague AI monologue">
<img src="screenshots/legit-tao.png" width="49%" alt="10 LEGIT: Terence Tao on the Lex Fridman podcast">
</p>

<p>
<img src="screenshots/meh-sleep.png" width="49%" alt="45 MEH: how to sleep less">
<img src="screenshots/legit-nutrition.png" width="49%" alt="15 LEGIT: all of nutrition science in 13 minutes">
</p>

<p>
<img src="screenshots/meh-startalk.png" width="49%" alt="60 MEH: podcast ramble on non-euclidean geometry">
<img src="screenshots/legit-3b1b.png" width="49%" alt="5 LEGIT: 3Blue1Brown on nonsquare matrices">
</p>

<p>
<img src="screenshots/bait-squats.png" width="49%" alt="78 BAIT: what 100 squats do to your body">
<img src="screenshots/legit-latpulldown.png" width="49%" alt="10 LEGIT: lat pulldown form cue">
</p>

<p>
<img src="screenshots/bait-supplements.png" width="49%" alt="72 BAIT: supplement clickbait">
<img src="screenshots/legit-omega3.png" width="49%" alt="15 LEGIT: analysis of 45 omega-3 studies">
</p>

<p>
<img src="screenshots/bait-pseudotest.png" width="49%" alt="72 BAIT: creative-or-analytical pseudo-test">
<img src="screenshots/bait-reading.png" width="49%" alt="75 BAIT: 21 benefits of reading books">
</p>

## The scale

The score measures how badly a video breaks the promise its title makes.

| Score | Verdict | |
|-------|---------|---------------|
| 0-20 | **LEGIT** | does what the title says |
| 21-40 | **MILD** | delivers, with some rambling |
| 41-60 | **MEH** | there's real content in there, buried in padding |
| 61-80 | **BAIT** | promises a lot more than it delivers |
| 81-100 | **SLOP** | filler stretched out for watch time |

## Setup

1. Get an API key from [Anthropic](https://console.anthropic.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys), or [Google Gemini](https://aistudio.google.com/apikey) - or use any OpenAI-compatible endpoint (Ollama, OpenRouter, Groq, vLLM).
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
3. Click the SlopShield icon, pick a provider, paste the key, **Save & test**.
4. Reload youtube.com.

## Notes

Scoring costs about $0.001-0.002 per video with the default models. Videos go out batched 4 per request and scores are cached for 30 days, so a homepage of ~30 videos costs a few cents, once. Against a local Ollama it's free.

There's no server. Your browser pulls the transcript from YouTube's player API and sends it to the provider you picked, with your key. That's the entire data path.

NO CAPTIONS on a tile means there was no transcript to judge (fresh uploads, live streams, age-restricted videos). ERROR is usually temporary and retries on its own.

## Files

```
manifest.json    extension manifest (MV3)
content.js       runs on youtube.com: finds tiles, fetches captions, renders overlays
background.js    service worker: batched model calls (Anthropic/OpenAI/Gemini/custom), persistent score cache
content.css      overlay styling
popup.html/.js   settings UI (provider, API key, model, pause switch)
```

## More examples

<p>
<img src="screenshots/bait-fitness.png" width="49%" alt="72 BAIT: five exercises that fix 95% of your problems">
<img src="screenshots/meh-pushups.png" width="49%" alt="58 MEH: 50 push-ups every day">
</p>

<p>
<img src="screenshots/bait-aurelius.png" width="49%" alt="72 BAIT: how to think clearly">
<img src="screenshots/bait-dopamine.png" width="49%" alt="68 BAIT: dopamine studying trick">
</p>

<p>
<img src="screenshots/bait-tedx-youth.png" width="49%" alt="72 BAIT: TEDx motivational speech">
<img src="screenshots/bait-tedx-plank.png" width="49%" alt="62 BAIT: TEDx mental toughness talk">
</p>

<p>
<img src="screenshots/legit-diagonalization.png" width="49%" alt="18 LEGIT: diagonalization explained">
<img src="screenshots/legit-physics.png" width="49%" alt="18 LEGIT: quantum mechanics explainer">
</p>

<p>
<img src="screenshots/bait-omarchy.png" width="49%" alt="62 BAIT: switch to Linux right now">
<img src="screenshots/bait-gta6.png" width="49%" alt="78 BAIT: GTA 6 hype commentary">
</p>

<p>
<img src="screenshots/legit-salmon.png" width="49%" alt="8 LEGIT: chef cooks salmon, exactly as titled">
</p>
