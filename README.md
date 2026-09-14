# ISMS Quest: the Lead Implementer

**Play it at [www.ismsquest.com](https://www.ismsquest.com)**

A browser game about ISO/IEC 27001:2022. You are the new lead implementer at Chaotic
Consulting, a company with 140 travelling laptops, a ministry contract and no information
security management system. Your job is to get them certified.

It is a teaching tool wearing a 16-bit costume. Every question is a decision a real
implementer faces, every wrong answer explains which clause you walked past, and the
standard's own order of operations is the thing the game rewards: context, then risk, then
the controls that answer it.

No install, no account. Three initials and you are playing.

## What it covers

Clauses 4 to 10 get a room each, in order. The Annex A themes get a wing of their own,
framed as an investigation rather than a quiz. Fifteen rooms in total, ending with a
certification audit at the gate.

| Room | Ground it covers |
| --- | --- |
| Reception | 4, context, interested parties, scope |
| Corner office | 5, leadership, policy, roles |
| Boardroom | 6, risk assessment, risk treatment, the Statement of Applicability |
| Training room | 7, competence, awareness, documented information |
| Rooftop | The external consultant, and the controls that answer him |
| Server room | 8, operational planning and control |
| Ops centre | 9, monitoring, internal audit, management review |
| Quality office | 10, nonconformity and continual improvement |
| The garden and four houses | Annex A, organisational, people, physical, technological |
| Certification audit | Eight questions drawn from the whole game, six to pass, against the clock |

Three rooms break the pattern on purpose. The ops centre is dark until you find the
flashlight. The server room is a chase. The corner office hides a mini-game where you play
the firewall. The Annex A wing is a whodunnit: somebody exported the risk register on a
Thursday evening, and you reconstruct the chain before naming the control that would have
broken each link.

## Playing

| | Keyboard | Touch |
| --- | --- | --- |
| Move | Arrow keys or WASD | The d-pad |
| Talk, read, pick up | Space, E or Enter | The A button |
| Answer | Click, or 1 to 4 | Tap an option |
| Notebook | N | The button above the screen |
| Pause | P or Escape | The PAUSE button |

Your score, management's trust in you and the company's risk exposure all move with every
decision, and together they decide the ending. Three hearts absorb the damage when risk
peaks. Losing them restarts the room you are in, never the run.

Progress saves in the browser after every answer and every room, so you can close the tab
and pick up from the title screen. Finish the game and your initials go on the scoreboard,
which is shared by everyone who plays.

The notebook (N) is the part worth keeping. It is a floor plan that fills in as you go: one
marker per clause you found, gold once you have produced the number yourself rather than
read it.

## Running it locally

No build step and no dependencies. Serve the folder and open it.

```bash
python3 -m http.server 8765
```

Then visit <http://127.0.0.1:8765>.

Appending `?dev` on localhost adds a developer bar for jumping between rooms, completing a
room instantly and opening the end screen. It is deliberately unreachable anywhere else:
the switches, the stored flag and the test hook are all off unless the page is served from
localhost, and a run made in developer mode never reaches the scoreboard.

## How it is put together

`index.html` is the whole game. All of it: the engine, the rooms, every question, the
sprites and the pixel art, which is drawn procedurally rather than loaded. The canvas is
512 by 384, a grid of 16 by 12 tiles. Sound effects are synthesised with the Web Audio API;
only the music is a file.

`api/scores.js` is the scoreboard, a single serverless function backed by an Upstash Redis
sorted set over its REST API, which is why the project needs no SDK and no build. It
validates what it stores, but none of that is a security boundary: anyone can post to it
with curl. The ceiling, the initials pattern and the per-address rate limit exist to keep
the board readable, not to prove a score was earned.

```
index.html        the game
api/scores.js     GET returns the board, POST takes one run
assets/           seven music tracks
```

## Deploying

Static hosting plus one serverless function. On Vercel it is zero-config. Three environment
variables:

| Variable | Where it comes from |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | The Upstash integration, which may name it `KV_REST_API_URL` |
| `UPSTASH_REDIS_REST_TOKEN` | The same, or `KV_REST_API_TOKEN` |
| `SCORE_SALT` | Any random string, and required. The rate limiter keys its counters by an HMAC of the caller's address under this secret, so the stored identifier is pseudonymous rather than anonymous: unreversible without the secret, but stable for the same address. Counters expire after an hour. Without the secret the function refuses to record rather than fall back to a guessable key |

Without the first two the game still runs: the scoreboard quietly falls back to a list kept
in the player's own browser. The board is served with a five-second edge cache so a burst of
readers costs one Redis call, and every Redis call carries a five-second deadline.

`vercel.json` sets the browser hardening headers: a Content Security Policy, `nosniff`,
`X-Frame-Options` and a referrer policy. The policy allows inline script because the game is
one inline script by design; the protection it buys is against framing, plugins, base-tag
hijacking and loading from anywhere but the game's own origin and its two font hosts.

Two abuse controls live in the dashboard rather than the repo and are worth setting before
sharing the link widely: an edge rate limit on `/api/scores` in Vercel's firewall, and spend
or usage alerts on both Vercel and Upstash. The function's own limit bounds accepted runs per
address; it does not bound how often the endpoint can be hit.

Vercel Web Analytics needs turning on in the project's Analytics tab; the page requests its
script only when it is not being served from localhost, so local sessions stay out of the
figures and out of the console.
